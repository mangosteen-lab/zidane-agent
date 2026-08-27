import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { CronScheduler, CronStore, matches, nextRun, parseSchedule, taskPrompt } from "../src/cron.mjs";
import { stageSkills } from "../src/runtime.mjs";

const utc = (text) => new Date(`${text}Z`);

test("cron expressions parse, match, and project the next firing in UTC", () => {
  assert.ok(matches(parseSchedule("0 2 * * *"), utc("2026-08-27T02:00")));
  assert.ok(!matches(parseSchedule("0 2 * * *"), utc("2026-08-27T02:01")));

  // Steps, ranges, lists, and three-letter names.
  const quarterly = parseSchedule("*/15 9-17 * * mon-fri");
  assert.ok(matches(quarterly, utc("2026-08-27T09:30")));   // a Thursday
  assert.ok(!matches(quarterly, utc("2026-08-27T09:31")));
  assert.ok(!matches(quarterly, utc("2026-08-29T09:30")));  // a Saturday
  assert.ok(matches(parseSchedule("0 0 1 jan,jul *"), utc("2027-07-01T00:00")));
  assert.ok(matches(parseSchedule("0 0 * * 7"), utc("2026-08-30T00:00")));  // 7 is Sunday

  // Standard cron: two restricted day fields are a union, not an intersection.
  const union = parseSchedule("0 0 1 * mon");
  assert.ok(matches(union, utc("2026-09-01T00:00")));  // the 1st, a Tuesday
  assert.ok(matches(union, utc("2026-08-31T00:00")));  // a Monday, not the 1st

  assert.equal(nextRun(parseSchedule("0 2 * * *"), Date.parse("2026-08-27T03:00:00Z")), Date.parse("2026-08-28T02:00:00Z"));
  // The one expression that outruns a single year.
  assert.equal(nextRun(parseSchedule("0 0 29 2 *"), Date.parse("2026-03-01T00:00:00Z")), Date.parse("2028-02-29T00:00:00Z"));

  for (const bad of ["", "0 2 * *", "60 * * * *", "* * * * 8", "5-1 * * * *", "*/0 * * * *", "0 2 * * xyz"]) {
    assert.throws(() => parseSchedule(bad), undefined, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test("a schedule fires once in its minute, is never made up after downtime, and keeps one success and one failure", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zidane-cron-test-"));
  try {
    const store = new CronStore({ crontab: resolve(root, "crontab") });
    const task = await store.create({
      name: "Nightly sweep", description: "Check the queue.", schedule: "0 2 * * *", skills: ["ops", "ops"],
    });
    assert.deepEqual(task.skills, ["ops"]);
    assert.equal(task.enabled, true);

    const at = Date.parse("2026-08-27T02:00:30Z");
    assert.deepEqual((await store.due(at)).map((item) => item.id), [task.id]);
    // Claimed on the first look, so the next tick inside the same minute does nothing.
    assert.deepEqual(await store.due(at + 20_000), []);
    // A minute that was missed entirely stays missed: no catch-up.
    assert.deepEqual(await store.due(Date.parse("2026-08-27T06:00:00Z")), []);
    assert.deepEqual((await store.due(Date.parse("2026-08-28T02:00:00Z"))).map((item) => item.id), [task.id]);

    // Only the newest success and the newest failure survive.
    for (const [status, text] of [["success", "first"], ["error", "boom"], ["success", "second"]]) {
      await store.record(task.id, {
        started_at: 1, finished_at: 2, status,
        ...(status === "success" ? { output: text } : { error: text }),
      });
    }
    const stored = JSON.parse(await readFile(resolve(root, "crontab", "history.json"), "utf8"));
    assert.equal(Object.keys(stored[task.id]).filter((key) => key !== "last_fired_minute").length, 2);
    const [listed] = (await store.list()).items;
    assert.equal(listed.last_success.output, "second");
    assert.equal(listed.last_failure.error, "boom");
    assert.ok(listed.next_run_at > Date.now());
    assert.equal(new Date(listed.next_run_at).toISOString().slice(11), "02:00:00.000Z");

    // The window bounds firing at both ends, and a disabled task never fires.
    await store.update({ task_id: task.id, starts_at: Date.parse("2026-09-01T00:00:00Z") });
    assert.deepEqual(await store.due(Date.parse("2026-08-30T02:00:00Z")), []);
    await store.update({ task_id: task.id, starts_at: null, ends_at: Date.parse("2026-08-29T00:00:00Z") });
    assert.deepEqual(await store.due(Date.parse("2026-08-30T02:00:00Z")), []);
    // A window that has closed has no next firing to show.
    await store.update({ task_id: task.id, ends_at: Date.parse("2020-01-01T00:00:00Z") });
    assert.equal((await store.list()).items[0].next_run_at, null);
    await store.update({ task_id: task.id, ends_at: null, enabled: false });
    assert.deepEqual(await store.due(Date.parse("2026-08-31T02:00:00Z")), []);

    await assert.rejects(store.create({ name: "bad", schedule: "not a schedule" }), /five fields/);
    await assert.rejects(
      store.create({ name: "bad", schedule: "0 2 * * *", starts_at: 2_000, ends_at: 1_000 }),
      /end time must be after start time/,
    );
    assert.equal(await store.delete(task.id), true);
    assert.deepEqual((await store.list()).items, []);
    assert.deepEqual(JSON.parse(await readFile(resolve(root, "crontab", "history.json"), "utf8")), {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the scheduler bounds its own lane and queues the rest", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zidane-cron-run-test-"));
  try {
    const store = new CronStore({ crontab: resolve(root, "crontab") });
    const started = [];
    const gates = new Map();
    const runtime = {
      runTask(input) {
        started.push(input);
        return new Promise((finish) => gates.set(input.id, () => finish("did the thing")));
      },
    };
    const scheduler = new CronScheduler(store, runtime, null, { limit: 2 });

    const tasks = [];
    for (const name of ["one", "two", "three"]) {
      tasks.push(await store.create({ name, description: `${name} runs`, schedule: "0 2 * * *", skills: ["ops"] }));
    }
    const running = scheduler.tick(Date.parse("2026-08-27T02:00:00Z"));
    await settle();
    // Two of the three start; the third waits for a slot rather than losing its firing.
    assert.deepEqual(started.map((item) => item.id), [tasks[0].id, tasks[1].id]);
    assert.equal(scheduler.active, 2);
    assert.equal(scheduler.queued, 1);

    gates.get(tasks[0].id)();
    await settle();
    // The freed slot goes to the task that has been waiting longest.
    assert.deepEqual(started.map((item) => item.id), [tasks[0].id, tasks[1].id, tasks[2].id]);
    assert.equal(scheduler.queued, 0);
    for (const release of gates.values()) release();
    // The tick resolves only once the queued work has run too.
    await running;
    assert.equal(scheduler.active, 0);

    // The prompt tells the model plainly that no one is listening.
    assert.match(started[0].prompt, /unattended/);
    assert.match(started[0].prompt, /Skills available to you: ops/);
    assert.deepEqual(started[0].skills, ["ops"]);

    const ran = (await store.list()).items.filter((item) => item.last_success);
    assert.equal(ran.length, 3);
    assert.equal(ran[0].last_success.output, "did the thing");
    assert.equal(ran[0].last_success.status, "success");
    assert.equal(ran[0].last_failure, null);

    // A failure is recorded as history, not thrown at the timer.
    const broken = await store.create({ name: "broken", schedule: "0 3 * * *", skills: [] });
    runtime.runTask = () => Promise.reject(new Error("the task blew up"));
    await scheduler.tick(Date.parse("2026-08-27T03:00:00Z"));
    const after = await store.get(broken.id);
    assert.equal(after.last_success, null);
    assert.equal(after.last_failure.status, "error");
    assert.match(after.last_failure.error, /the task blew up/);

    // Running on demand ignores the schedule, but not the lane.
    assert.deepEqual(await scheduler.runNow(broken.id), { started: true, queued: false });
    await assert.rejects(scheduler.runNow("no-such-task"), /no such scheduled task/);
    assert.match(taskPrompt({ name: "x", schedule: "* * * * *" }), /Schedule: \* \* \* \* \* \(UTC\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a queued task is honoured as it stands when its slot comes, and never stacks up", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zidane-cron-queue-test-"));
  try {
    const store = new CronStore({ crontab: resolve(root, "crontab") });
    const started = [];
    const gates = new Map();
    const runtime = {
      runTask(input) {
        started.push(input.id);
        return new Promise((finish) => gates.set(input.id, () => finish("done")));
      },
    };
    const scheduler = new CronScheduler(store, runtime, null, { limit: 1 });
    const blocker = await store.create({ name: "blocker", schedule: "* * * * *", skills: [] });
    const waiter = await store.create({ name: "waiter", schedule: "* * * * *", skills: [] });

    const first = scheduler.tick(Date.parse("2026-08-27T02:00:00Z"));
    await settle();
    assert.deepEqual(started, [blocker.id]);
    assert.equal(scheduler.queued, 1);

    // A firing that arrives while the same task is still pending is not stacked on top.
    void scheduler.tick(Date.parse("2026-08-27T02:01:00Z"));
    await settle();
    assert.equal(scheduler.queued, 1);

    // Paused while it waited: the version that runs is the one that stands now.
    await store.update({ task_id: waiter.id, enabled: false });
    gates.get(blocker.id)();
    await first;
    assert.deepEqual(started, [blocker.id]);
    assert.equal(scheduler.queued, 0);
    assert.equal((await store.get(waiter.id)).last_success, null);

    // A full queue is the one case where a firing is still dropped.
    const small = new CronScheduler(store, { runTask: () => new Promise(() => {}) }, null, { limit: 1, queueLimit: 1 });
    await store.update({ task_id: waiter.id, enabled: true });
    const third = await store.create({ name: "third", schedule: "* * * * *", skills: [] });
    void small.tick(Date.parse("2026-08-27T02:02:00Z"));
    await settle();
    assert.equal(small.active, 1);
    assert.equal(small.queued, 1);
    assert.equal((await store.get(third.id)).last_success, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a scheduled task is staged with only the skills it names", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zidane-cron-skills-test-"));
  try {
    const skills = resolve(root, "skills");
    for (const name of ["Release Notes", "Danger Zone"]) {
      const directory = resolve(skills, name.toLowerCase().replace(/ /g, "-"));
      await mkdir(directory, { recursive: true });
      await writeFile(resolve(directory, "SKILL.md"), `---\nname: ${name}\n---\n\n# ${name}\n`);
    }
    const staged = resolve(root, "staged");
    assert.deepEqual(await stageSkills(skills, ["Release Notes"], staged), ["Release Notes"]);
    assert.match(await readFile(resolve(staged, "Release_Notes", "SKILL.md"), "utf8"), /Release Notes/);
    // The skill the task did not name is not reachable from an unattended run.
    await assert.rejects(readFile(resolve(staged, "Danger_Zone", "SKILL.md"), "utf8"), { code: "ENOENT" });
    await assert.rejects(stageSkills(skills, ["Nonexistent"], staged), /none of the task's skills are installed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** Let the scheduler's own await of `store.due()` resolve before inspecting it. */
function settle() { return new Promise((done) => setTimeout(done, 10)); }
