/**
 * Coming back to a conversation later.
 *
 * A session that starts something slow — a build, a deployment, an import, a test run —
 * has no way to look at it again: it answers, the turn ends, and nothing in the system
 * ever wakes it. Sleeping inside the turn is not an answer either. It would hold a
 * capacity slot for hours, block that conversation, and die with the next restart.
 *
 * So a session can ask to be woken: `check_back(minutes, note)` stores one pending wake
 * for its conversation, and when it comes due the agent prompts **that same
 * conversation** again. Same thread, same Pi session, same history — the model reads its
 * own note, looks at whatever it started, and either reports the outcome or asks to be
 * woken again. What the person sees is the agent coming back to them in the thread they
 * were already in.
 *
 * One wake at a time, per conversation, re-armed by hand:
 *
 *   - a repeating schedule has no natural end, and this always has one — the job
 *     finishes. Re-arming is a decision the model makes each time, which is also what
 *     lets it back off from five minutes to fifteen when nothing is happening;
 *   - the whole watch is bounded from when it started, not from the last wake, so a
 *     model that keeps re-arming still stops;
 *   - and the last wake says it is the last, so a watch that runs out of time ends with
 *     the agent saying so rather than going quiet.
 *
 * The control plane is not involved and gains no scheduler: a wake is an ordinary prompt
 * on an existing conversation, and the reply is recorded exactly as any other reply in
 * that thread is.
 */

import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** How soon a wake may be asked for, and how far out. */
export const MIN_MINUTES = 1;
export const MAX_MINUTES = 1_440;
/** From the first `check_back`, not the last: re-arming extends nothing. */
export const MAX_WATCH_MS = 24 * 60 * 60 * 1_000;
/** A backstop for a model that re-arms every minute for a day. */
export const MAX_ATTEMPTS = 120;
/** Conversations that may have a wake pending at once. */
export const MAX_PENDING = 50;

const FILE = "pending.json";

export class FollowUpStore {
  #pending = Promise.resolve();

  constructor(local) {
    this.path = resolve(local.followUps, FILE);
  }

  /** Serialised like every other agent store: two writers would lose one of the two. */
  #serial(work) {
    const task = this.#pending.then(work, work);
    this.#pending = task.catch(() => undefined);
    return task;
  }

  /**
   * What is pending, and what each conversation's watch has already done.
   *
   * `watched` is the lineage: a wake is taken out of `items` when it fires, so without it
   * a re-arm would look like a brand new watch and the bound on the whole thing would
   * start again from zero every time the model asked for one more look.
   */
  async #read() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      return {
        items: Array.isArray(parsed?.items) ? parsed.items : [],
        watched: parsed?.watched && typeof parsed.watched === "object" ? parsed.watched : {},
      };
    } catch { return { items: [], watched: {} }; }
  }

  async #write(state, now = Date.now()) {
    // A watch nobody re-armed is finished; its lineage stops meaning anything once no
    // wake could still belong to it.
    const watched = Object.fromEntries(Object.entries(state.watched ?? {})
      .filter(([, entry]) => now - Number(entry?.watching_since ?? 0) < MAX_WATCH_MS));
    await mkdir(resolve(this.path, ".."), { recursive: true });
    const temporary = `${this.path}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    await writeFile(temporary, JSON.stringify({ items: state.items, watched }, null, 2), { mode: 0o600 });
    await rename(temporary, this.path);
  }

  list() {
    return this.#serial(async () => (await this.#read()).items);
  }

  /**
   * Arm, or re-arm, the wake for one conversation.
   *
   * Replacing rather than adding is what keeps this a follow-up instead of a schedule:
   * a conversation waking twice over the same thing has nothing extra to say. A re-arm
   * carries the original start and the count forward, so the bound is on the watch and
   * not on the latest leg of it.
   */
  arm({ conversation, note, minutes, now = Date.now() }) {
    return this.#serial(async () => {
      const wait = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(Number(minutes) || 0)));
      const state = await this.#read();
      const pending = state.items.find((item) => item.conversation_id === conversation);
      const others = state.items.filter((item) => item.conversation_id !== conversation);
      if (!pending && others.length >= MAX_PENDING) {
        throw new Error(`this agent is already watching ${MAX_PENDING} conversations; finish one before starting another`);
      }
      // Either the wake this replaces, or the one that just fired and is asking for
      // another look. Both are the same watch, and carry the same bound.
      const lineage = pending ?? state.watched[conversation];
      const since = Number(lineage?.watching_since) || now;
      const deadline = since + MAX_WATCH_MS;
      const attempts = Number(lineage?.attempts) || 0;
      if (attempts >= MAX_ATTEMPTS || now >= deadline) {
        throw new Error("this conversation has been watching the same thing for as long as it may; say where it stands and stop");
      }
      const record = {
        id: pending?.id ?? crypto.randomUUID(),
        conversation_id: conversation,
        note: String(note ?? "").slice(0, 2_000),
        minutes: wait,
        // Never past the deadline: the last wake happens *at* it, so the watch ends with
        // the agent saying where things stand rather than with silence.
        due_at: Math.min(now + wait * 60_000, deadline),
        watching_since: since,
        expires_at: deadline,
        attempts,
      };
      await this.#write({ items: [...others, record], watched: state.watched }, now);
      return record;
    });
  }

  /** Drop the wake for one conversation, and its lineage: the next one starts fresh. */
  cancel(conversation, now = Date.now()) {
    return this.#serial(async () => {
      const state = await this.#read();
      const kept = state.items.filter((item) => item.conversation_id !== conversation);
      const had = kept.length !== state.items.length || conversation in state.watched;
      if (!had) return false;
      const { [conversation]: _dropped, ...watched } = state.watched;
      await this.#write({ items: kept, watched }, now);
      return true;
    });
  }

  /**
   * Take everything due, removing it as it goes.
   *
   * Claimed rather than read: a wake taken out of the file before it is prompted cannot
   * be fired twice by the next tick, and an agent that was down for an hour comes back
   * to one overdue wake per conversation rather than an hour of them.
   */
  claimDue(now = Date.now(), limit = 3) {
    return this.#serial(async () => {
      const state = await this.#read();
      const due = state.items.filter((item) => item.due_at <= now).slice(0, limit);
      if (!due.length) return [];
      const ids = new Set(due.map((item) => item.id));
      await this.#write({ items: state.items.filter((item) => !ids.has(item.id)), watched: state.watched }, now);
      return due;
    });
  }

  /**
   * Record that a wake actually ran.
   *
   * Separate from claiming it, because a wake the runtime refused has not happened: it
   * goes back in the file and must not count against the watch.
   */
  noteWoken(record, now = Date.now()) {
    return this.#serial(async () => {
      const state = await this.#read();
      state.watched[record.conversation_id] = {
        watching_since: record.watching_since,
        attempts: record.attempts + 1,
      };
      await this.#write(state, now);
    });
  }

  /** Put a claimed wake back, unchanged, when it could not be run after all. */
  restore(record, now = Date.now()) {
    return this.#serial(async () => {
      const state = await this.#read();
      if (state.items.some((item) => item.conversation_id === record.conversation_id)) return;
      await this.#write({ items: [...state.items, record], watched: state.watched }, now);
    });
  }
}

/** True when this wake is the last one this watch is allowed. */
export function isFinalWake(record, now = Date.now()) {
  return record.attempts + 1 >= MAX_ATTEMPTS || now >= record.expires_at;
}

/**
 * What the agent is asked when a wake comes due.
 *
 * Written to the model that left the note, in the conversation it left it in. It says
 * plainly that this is the only prompt it will get: the failure mode of a follow-up is a
 * model that answers "I'll keep an eye on it" and never calls anything.
 */
export function wakePrompt(record, { final = false } = {}) {
  const waited = record.minutes === 1 ? "a minute" : `${record.minutes} minutes`;
  return [
    `This is the follow-up you asked for ${waited} ago, in this conversation. Nobody typed it.`,
    "",
    `What you asked to be reminded of: ${record.note}`,
    "",
    final
      ? "This is the last check — the watch has reached its limit. Report where things stand now, "
        + "say plainly that you have stopped watching, and do not call check_back again."
      : "Look at it now. If it has finished, or failed, say so here with the outcome — that message is "
        + "what the person waiting will read. If it is still going, call check_back again to keep "
        + `looking; if you do not, nothing will bring you back. You have been checking every ${waited}, `
        + "so use that again unless there is a reason to change it — and if the person asked for an "
        + "interval, it is theirs, not yours. Keep it short while there is nothing to report.",
  ].join("\n");
}

/**
 * The timer that fires due wakes.
 *
 * Deliberately not its own lane, unlike cron: a wake speaks in a conversation, so it
 * belongs in the same capacity a conversation costs. Being refused is normal and
 * harmless — the wake goes back in the file and the next tick tries again.
 */
export class FollowUpScheduler {
  #timer = null;

  constructor(store, runtime, logger, { intervalMs = 30_000, perTick = 3 } = {}) {
    this.store = store;
    this.runtime = runtime;
    this.logger = logger;
    this.intervalMs = intervalMs;
    this.perTick = perTick;
  }

  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick().catch((error) => this.logger?.log("warning", "follow-up tick failed", { error: String(error) }));
    }, this.intervalMs);
    this.#timer.unref?.();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async tick(now = Date.now()) {
    const due = await this.store.claimDue(now, this.perTick);
    const woken = [];
    for (const record of due) {
      const final = isFinalWake(record, now);
      try {
        this.runtime.prompt({
          delivery_id: crypto.randomUUID(),
          conversation_id: record.conversation_id,
          text: wakePrompt(record, { final }),
        });
        await this.store.noteWoken(record, now);
        woken.push(record.id);
        this.logger?.log("info", "follow-up woke a conversation", {
          conversation_id: record.conversation_id, attempt: record.attempts + 1, final,
        });
      } catch (error) {
        // Busy, or at capacity: both mean "not now", and neither is a failed attempt.
        // A wake that cannot run yet is worth nothing unless it runs later.
        await this.store.restore(record, now);
        this.logger?.log("info", "follow-up deferred", {
          conversation_id: record.conversation_id, reason: String(error?.reason ?? error),
        });
      }
    }
    return woken;
  }
}
