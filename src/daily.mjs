/**
 * The agent's daily journal, and the digest it writes into memory each day.
 *
 * Every completed prompt appends one line to `memory/journal/<date>.jsonl` — what was
 * asked, the opening of what came back, and which conversation it belonged to. At the
 * turn of the day the agent reads yesterday's lines, asks its own model what the day
 * amounted to, and stores that as a memory.
 *
 * The journal exists so the digest has something small and bounded to read. Session
 * transcripts are the real record, but they are event dumps: far too large to hand a
 * model, and mostly noise.
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const MAX_ENTRIES = 400;
const MAX_JOURNAL_DAYS = 14;
export const DIGEST_CONVERSATION = "daily-digest";

const DIGEST_PROMPT = `Below is a journal of everything you worked on during one day, one
entry per exchange. Write a short note to your future self about that day: what you were
asked for, what you actually did, what you decided, and anything you learned that would
save you time if it comes up again. Group related work rather than listing entries.
Leave out pleasantries and anything already obvious. Write prose, at most 250 words, and
include no credentials or secret material.`;

export function today(at = Date.now()) {
  return new Date(at).toISOString().slice(0, 10);
}

export class DailyJournal {
  constructor(local, logger) {
    this.local = local;
    this.logger = logger;
    this.directory = resolve(local.memory, "journal");
    this.state = resolve(this.directory, "state.json");
  }

  #path(date) {
    return resolve(this.directory, `${date}.jsonl`);
  }

  /** One line per exchange. Truncated hard: this is a record, not a transcript. */
  async record(entry) {
    try {
      await mkdir(this.directory, { recursive: true });
      const line = JSON.stringify({
        at: new Date().toISOString(),
        conversation: String(entry.conversation ?? ""),
        prompt: String(entry.prompt ?? "").trim().slice(0, 600),
        answer: String(entry.answer ?? "").trim().slice(0, 600),
        status: String(entry.status ?? ""),
      });
      await writeFile(this.#path(today()), `${line}\n`, { flag: "a" });
    } catch (error) {
      // A journal failure must never take a prompt down with it.
      this.logger?.log("warning", "journal entry not recorded", { error: String(error) });
    }
  }

  async entries(date) {
    try {
      const raw = await readFile(this.#path(date), "utf8");
      return raw.split("\n").filter(Boolean).slice(-MAX_ENTRIES).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  }

  async #lastDigested() {
    try { return String(JSON.parse(await readFile(this.state, "utf8")).digested ?? ""); }
    catch { return ""; }
  }

  async #markDigested(date) {
    const pending = `${this.state}.new`;
    await writeFile(pending, JSON.stringify({ digested: date }, null, 2), { mode: 0o600 });
    await rename(pending, this.state);
  }

  /** Days with entries that have not been digested yet, oldest first, today excluded. */
  async pending() {
    let names = [];
    try { names = await readdir(this.directory); } catch { return []; }
    const last = await this.#lastDigested();
    const current = today();
    return names
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .map((name) => name.slice(0, -".jsonl".length))
      .filter((date) => date < current && date > last)
      .sort();
  }

  async #prune() {
    let names = [];
    try { names = await readdir(this.directory); } catch { return; }
    const dates = names.filter((name) => name.endsWith(".jsonl")).sort();
    for (const name of dates.slice(0, Math.max(0, dates.length - MAX_JOURNAL_DAYS))) {
      await rm(resolve(this.directory, name), { force: true });
    }
  }

  /**
   * Summarise each undigested day into memory.
   *
   * Runs at most one day per call, oldest first, so a long outage catches up over
   * successive ticks rather than in one burst of model calls.
   */
  async digest(runtime, memory) {
    const [date] = await this.pending();
    if (!date) return null;
    const entries = await this.entries(date);
    if (!entries.length) {
      await this.#markDigested(date);
      return null;
    }
    const journal = entries
      .map((entry) => `- [${entry.at}] ${entry.conversation}\n  asked: ${entry.prompt}\n  did: ${entry.answer}`)
      .join("\n");
    const summary = await runtime.summarise(
      DIGEST_CONVERSATION,
      `${DIGEST_PROMPT}\n\n--- ${date} ---\n${journal}`,
    );
    if (!summary) {
      // Leave the day undigested; the next tick tries again.
      this.logger?.log("warning", "daily digest produced nothing", { date });
      return null;
    }
    const stored = await memory.add(
      { text: summary, tags: ["daily", date], sensitivity: "normal" },
      "agent",
    );
    await this.#markDigested(date);
    await this.#prune();
    this.logger?.log("info", "daily digest written", { date, memory_id: stored.id, entries: entries.length });
    return { date, memory_id: stored.id, entries: entries.length };
  }
}
