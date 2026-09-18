import assert from "node:assert/strict";
import { test } from "node:test";
import { AccountSyncScheduler, DEFAULT_MINUTES, MIN_MINUTES, syncEnabled, syncMinutes } from "../src/account-sync.mjs";

test("the interval is read from the environment and kept sane", () => {
  assert.equal(syncMinutes({}), DEFAULT_MINUTES);
  assert.equal(syncMinutes({ ZIDANE_AGENT_ACCOUNT_SYNC_MINUTES: "30" }), 30);
  // Nonsense reads as the default rather than as zero, which would ask every tick.
  assert.equal(syncMinutes({ ZIDANE_AGENT_ACCOUNT_SYNC_MINUTES: "nope" }), DEFAULT_MINUTES);
  assert.equal(syncMinutes({ ZIDANE_AGENT_ACCOUNT_SYNC_MINUTES: "0" }), DEFAULT_MINUTES);
  assert.equal(syncMinutes({ ZIDANE_AGENT_ACCOUNT_SYNC_MINUTES: "-5" }), DEFAULT_MINUTES);
  // Clamped at both ends: a one-minute sync is a denial of service on your own server.
  assert.equal(syncMinutes({ ZIDANE_AGENT_ACCOUNT_SYNC_MINUTES: "1" }), MIN_MINUTES);
  assert.equal(syncMinutes({ ZIDANE_AGENT_ACCOUNT_SYNC_MINUTES: "999999" }), 7 * 24 * 60);

  assert.equal(syncEnabled({}), true);
  assert.equal(syncEnabled({ ZIDANE_AGENT_ACCOUNT_SYNC: "false" }), false);
});

test("the agent asks on its own clock, and again when it reconnects", () => {
  const sent = [];
  let now = 1_000_000;
  const scheduler = new AccountSyncScheduler((type, body) => sent.push({ type, body }), null, {
    minutes: 60,
    now: () => now,
  });

  // Nothing before the first interval has passed — a restart does not stampede.
  assert.equal(scheduler.tick(), false);
  assert.equal(sent.length, 0);

  // A reconnect asks straight away: something may have changed while it was down, and
  // nothing queued that for it.
  scheduler.request("reconnect");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "ACCOUNT_SYNC_REQUEST");
  assert.equal(sent[0].body.reason, "reconnect");

  // And that resets the clock, so a reconnect does not double-ask.
  now += 59 * 60_000;
  assert.equal(scheduler.tick(), false);
  assert.equal(sent.length, 1);

  now += 2 * 60_000;
  assert.equal(scheduler.tick(), true);
  assert.equal(sent.at(-1).body.reason, "timer");

  // One ask per interval, not one per tick.
  assert.equal(scheduler.tick(), false);
  assert.equal(sent.length, 2);
});

test("a stopped scheduler asks nothing", () => {
  const sent = [];
  const scheduler = new AccountSyncScheduler((type) => sent.push(type), null, { minutes: 5 });
  scheduler.start();
  scheduler.start();
  scheduler.stop();
  scheduler.stop();
  assert.deepEqual(sent, []);
});
