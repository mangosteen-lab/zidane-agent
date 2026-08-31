import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  FollowUpScheduler, FollowUpStore, MAX_ATTEMPTS, MAX_WATCH_MS, isFinalWake, wakePrompt,
} from "../src/follow-up.mjs";
import { BusyError } from "../src/runtime.mjs";

const MINUTE = 60_000;

async function store() {
  const root = await mkdtemp(resolve(tmpdir(), "zidane-followup-test-"));
  return { root, store: new FollowUpStore({ followUps: resolve(root, "follow-ups") }) };
}

test("a conversation has one pending wake, and re-arming replaces it", async () => {
  const { root, store: pending } = await store();
  try {
    const now = Date.parse("2026-08-31T09:00:00Z");
    const first = await pending.arm({ conversation: "thread-1", note: "build 42", minutes: 10, now });
    assert.equal(first.due_at, now + 10 * MINUTE);
    assert.equal(first.attempts, 0);

    // Asking again is the same watch looking again, not a second one stacked on it.
    const again = await pending.arm({ conversation: "thread-1", note: "build 42, still queued", minutes: 5, now });
    assert.equal(again.id, first.id);
    assert.equal(again.watching_since, first.watching_since);
    assert.deepEqual((await pending.list()).map((item) => item.conversation_id), ["thread-1"]);

    // A different conversation is its own watch.
    await pending.arm({ conversation: "thread-2", note: "deploy", minutes: 1, now });
    assert.equal((await pending.list()).length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("only what is due is claimed, and claiming it takes it out of the file", async () => {
  const { root, store: pending } = await store();
  try {
    const now = Date.parse("2026-08-31T09:00:00Z");
    await pending.arm({ conversation: "soon", note: "a", minutes: 1, now });
    await pending.arm({ conversation: "later", note: "b", minutes: 30, now });

    assert.deepEqual(await pending.claimDue(now), []);
    const due = await pending.claimDue(now + 2 * MINUTE);
    assert.deepEqual(due.map((item) => item.conversation_id), ["soon"]);
    // Claimed means gone: an agent that was down for an hour comes back to one overdue
    // wake per conversation, not an hour of them.
    assert.deepEqual(await pending.claimDue(now + 2 * MINUTE), []);
    assert.deepEqual((await pending.list()).map((item) => item.conversation_id), ["later"]);

    // A wake that could not run goes back exactly as it was.
    await pending.restore(due[0]);
    assert.deepEqual((await pending.claimDue(now + 2 * MINUTE)).map((item) => item.note), ["a"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the watch is bounded from when it started, not from the last look", async () => {
  const { root, store: pending } = await store();
  try {
    const start = Date.parse("2026-08-31T09:00:00Z");
    let record = await pending.arm({ conversation: "long", note: "a slow job", minutes: 60, now: start });

    // Twenty hours of re-arming later, the lineage still points at the beginning.
    for (let hour = 1; hour <= 20; hour += 1) {
      const now = start + hour * 60 * MINUTE;
      const [due] = await pending.claimDue(now);
      assert.ok(due, `a wake was due at hour ${hour}`);
      await pending.noteWoken(due, now);
      record = await pending.arm({ conversation: "long", note: "still going", minutes: 60, now });
      assert.equal(record.watching_since, start);
      assert.equal(record.attempts, hour);
    }
    assert.equal(record.expires_at, start + MAX_WATCH_MS);

    // Past the deadline it is refused outright, so a model cannot watch one thing forever.
    await assert.rejects(
      () => pending.arm({ conversation: "long", note: "one more", minutes: 60, now: start + MAX_WATCH_MS + 1 }),
      /as long as it may/,
    );

    // The wake that lands on the deadline is the last one, and says so.
    assert.equal(isFinalWake({ attempts: 3, expires_at: start + MAX_WATCH_MS }, start + MAX_WATCH_MS), true);
    assert.equal(isFinalWake({ attempts: MAX_ATTEMPTS - 1, expires_at: start + MAX_WATCH_MS }, start), true);
    assert.equal(isFinalWake({ attempts: 3, expires_at: start + MAX_WATCH_MS }, start), false);
    assert.match(wakePrompt({ minutes: 5, note: "n", attempts: 0 }, { final: true }), /last check/);
    assert.match(wakePrompt({ minutes: 5, note: "n", attempts: 0 }), /call check_back again/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cancelling ends the watch, and the next one starts clean", async () => {
  const { root, store: pending } = await store();
  try {
    const now = Date.parse("2026-08-31T09:00:00Z");
    await pending.arm({ conversation: "t", note: "a", minutes: 5, now });
    const [due] = await pending.claimDue(now + 6 * MINUTE);
    await pending.noteWoken(due, now + 6 * MINUTE);

    assert.equal(await pending.cancel("t"), true);
    assert.equal(await pending.cancel("t"), false);
    const fresh = await pending.arm({ conversation: "t", note: "something else", minutes: 5, now: now + 7 * MINUTE });
    assert.equal(fresh.attempts, 0);
    assert.equal(fresh.watching_since, now + 7 * MINUTE);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a due wake prompts its own conversation, and a busy one waits rather than being lost", async () => {
  const { root, store: pending } = await store();
  try {
    const now = Date.parse("2026-08-31T09:00:00Z");
    const prompts = [];
    let refuse = true;
    const runtime = {
      prompt(delivery) {
        if (refuse) throw new BusyError("conversation");
        prompts.push(delivery);
      },
    };
    const scheduler = new FollowUpScheduler(pending, runtime, null);
    await pending.arm({ conversation: "thread-1", note: "build 42 at https://ci.example.test/42", minutes: 5, now });

    // The conversation is mid-prompt: the wake goes back in the file untouched.
    assert.deepEqual(await scheduler.tick(now + 6 * MINUTE), []);
    assert.equal(prompts.length, 0);
    assert.equal((await pending.list())[0].attempts, 0, "a refused wake is not an attempt");

    refuse = false;
    const woken = await scheduler.tick(now + 7 * MINUTE);
    assert.equal(woken.length, 1);
    assert.equal(prompts.length, 1);
    // It wakes the conversation it belongs to, which is what puts the reply in that thread.
    assert.equal(prompts[0].conversation_id, "thread-1");
    assert.match(prompts[0].text, /build 42 at https:\/\/ci\.example\.test\/42/);
    assert.match(prompts[0].text, /Nobody typed it/);
    assert.ok(prompts[0].delivery_id);
    // Fired once, and gone until something asks again.
    assert.deepEqual(await pending.list(), []);
    assert.deepEqual(await scheduler.tick(now + 8 * MINUTE), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
