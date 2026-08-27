import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Agent-private scheduled tasks.
 *
 * A crontab entry is a standing instruction the agent gives itself. It runs silently —
 * nothing is emitted to any chat — in a session of its own that is destroyed the moment
 * the run ends, so a schedule can never accumulate context or leak into a conversation.
 * The list and its history live on disk beside memory, which is what makes them travel
 * with an agent migration.
 */

const MINUTE = 60_000;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, offset: 1 },
  { name: "day of week", min: 0, max: 6, names: DAYS, offset: 0 },
];
const MAX_OUTPUT_BYTES = 8_000;

/**
 * Parse a five-field cron expression.
 *
 * Deliberately hand-rolled: the agent ships four dependencies and `npm audit` gates CI,
 * so standard cron syntax — `*`, `a`, `a-b`, `a,b`, `*​/n`, `a-b/n`, and three-letter month
 * and day names — is not worth a package.
 */
export function parseSchedule(expression) {
  const parts = String(expression ?? "").trim().toLowerCase().split(/\s+/);
  if (parts.length !== 5) throw new Error("schedule must have five fields: minute hour day-of-month month day-of-week");
  const fields = parts.map((part, index) => parseField(part, FIELDS[index]));
  return {
    expression: String(expression).trim(),
    minute: fields[0], hour: fields[1], dayOfMonth: fields[2], month: fields[3], dayOfWeek: fields[4],
    // Standard cron: when both day fields are restricted the entry fires if *either*
    // matches, which is why "0 0 1 * mon" means the 1st and every Monday.
    dayUnion: parts[2] !== "*" && parts[4] !== "*",
    everyDayOfMonth: parts[2] === "*",
    everyDayOfWeek: parts[4] === "*",
  };
}

function parseField(part, field) {
  const values = new Set();
  for (const item of part.split(",")) {
    const [range, stepText] = item.split("/");
    if (stepText !== undefined && !/^\d+$/.test(stepText)) throw new Error(`invalid step in the ${field.name} field`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) throw new Error(`step must be at least 1 in the ${field.name} field`);
    let from, to;
    if (range === "*") { from = field.min; to = field.max; }
    else {
      const bounds = range.split("-");
      if (bounds.length > 2 || bounds.some((bound) => bound === "")) throw new Error(`invalid ${field.name} field: ${item}`);
      from = boundary(bounds[0], field);
      to = bounds.length === 2 ? boundary(bounds[1], field) : from;
      // A bare value with a step ("5/15") means "from 5 to the end of the field".
      if (bounds.length === 1 && stepText !== undefined) to = field.max;
    }
    if (from > to) throw new Error(`the ${field.name} range runs backwards: ${item}`);
    for (let value = from; value <= to; value += step) values.add(value);
  }
  if (!values.size) throw new Error(`the ${field.name} field matches nothing`);
  return values;
}

function boundary(text, field) {
  let value;
  if (/^\d+$/.test(text)) value = Number(text);
  else {
    const index = field.names?.indexOf(text) ?? -1;
    if (index < 0) throw new Error(`invalid ${field.name} value: ${text}`);
    value = index + (field.offset ?? 0);
  }
  // Cron accepts 7 for Sunday as well as 0.
  if (field.name === "day of week" && value === 7) value = 0;
  if (value < field.min || value > field.max) throw new Error(`${field.name} must be between ${field.min} and ${field.max}`);
  return value;
}

/** Does this schedule fire in the UTC minute containing `date`? */
export function matches(schedule, date) {
  if (!schedule.minute.has(date.getUTCMinutes())) return false;
  if (!schedule.hour.has(date.getUTCHours())) return false;
  if (!schedule.month.has(date.getUTCMonth() + 1)) return false;
  const dayOfMonth = schedule.dayOfMonth.has(date.getUTCDate());
  const dayOfWeek = schedule.dayOfWeek.has(date.getUTCDay());
  if (schedule.dayUnion) return dayOfMonth || dayOfWeek;
  return (schedule.everyDayOfMonth || dayOfMonth) && (schedule.everyDayOfWeek || dayOfWeek);
}

/** The next UTC firing strictly after `from`, or null if the schedule never fires again. */
export function nextRun(schedule, from = Date.now()) {
  const start = Math.floor(from / MINUTE) * MINUTE + MINUTE;
  // Four years covers the one expression that can outrun a single year: 29 February.
  const limit = start + 366 * 4 * 24 * 60 * MINUTE;
  for (let at = start; at <= limit; at += MINUTE) {
    if (matches(schedule, new Date(at))) return at;
  }
  return null;
}

/**
 * The task list and its history, on disk.
 *
 * History is capped at one successful and one failed run per task, as a schedule that
 * fires every minute would otherwise fill the agent's disk with transcripts nobody reads.
 */
export class CronStore {
  #pending = Promise.resolve();

  constructor(local) {
    this.root = local.crontab;
    this.tasksFile = resolve(this.root, "tasks.json");
    this.historyFile = resolve(this.root, "history.json");
  }

  /** Serialised so a scheduled run recording its result cannot race an edit from the UI. */
  #serial(work) {
    const task = this.#pending.then(work);
    this.#pending = task.catch(() => undefined);
    return task;
  }

  async #readTasks() { return (await readJson(this.tasksFile, { tasks: [] })).tasks ?? []; }
  async #readHistory() { return await readJson(this.historyFile, {}); }
  async #writeTasks(tasks) { await atomicJson(this.tasksFile, { version: 1, tasks }); }
  async #writeHistory(history) { await atomicJson(this.historyFile, history); }

  list() { return this.#serial(async () => ({ items: await this.#decorated() })); }

  async #decorated() {
    const [tasks, history] = await Promise.all([this.#readTasks(), this.#readHistory()]);
    const now = Date.now();
    return tasks.map((task) => {
      const record = history[task.id] ?? {};
      let next = null;
      try { next = task.enabled ? nextRun(parseSchedule(task.schedule), Math.max(now, task.starts_at ?? 0)) : null; }
      catch { next = null; }
      if (next !== null && task.ends_at && next > task.ends_at) next = null;
      return {
        ...task,
        next_run_at: next,
        last_success: record.success ?? null,
        last_failure: record.failure ?? null,
      };
    });
  }

  get(taskId) { return this.#serial(async () => (await this.#decorated()).find((task) => task.id === String(taskId ?? "")) ?? null); }

  create(input) {
    return this.#serial(async () => {
      const tasks = await this.#readTasks();
      if (tasks.length >= 100) throw new Error("an agent may hold at most 100 scheduled tasks");
      const now = Date.now();
      const task = { id: crypto.randomUUID(), created_at: now, updated_at: now, ...validate(input) };
      tasks.push(task);
      await this.#writeTasks(tasks);
      return task;
    });
  }

  update(input) {
    return this.#serial(async () => {
      const tasks = await this.#readTasks();
      const index = tasks.findIndex((task) => task.id === String(input.task_id ?? ""));
      if (index < 0) throw new Error("no such scheduled task");
      tasks[index] = { ...tasks[index], ...validate({ ...tasks[index], ...input }), updated_at: Date.now() };
      await this.#writeTasks(tasks);
      return tasks[index];
    });
  }

  delete(taskId) {
    return this.#serial(async () => {
      const tasks = await this.#readTasks();
      const remaining = tasks.filter((task) => task.id !== String(taskId ?? ""));
      if (remaining.length === tasks.length) return false;
      await this.#writeTasks(remaining);
      const history = await this.#readHistory();
      delete history[String(taskId)];
      await this.#writeHistory(history);
      return true;
    });
  }

  /**
   * The tasks whose schedule names the UTC minute containing `now` and that have not
   * already fired in it.
   *
   * A missed minute is never made up: an agent that was offline at 02:00 picks the
   * schedule back up tomorrow rather than firing a nightly job at breakfast.
   */
  due(now = Date.now()) {
    return this.#serial(async () => {
      const [tasks, history] = await Promise.all([this.#readTasks(), this.#readHistory()]);
      const minute = Math.floor(now / MINUTE) * MINUTE;
      const ready = [];
      let changed = false;
      for (const task of tasks) {
        if (!task.enabled) continue;
        if (task.starts_at && now < task.starts_at) continue;
        if (task.ends_at && now > task.ends_at) continue;
        const record = history[task.id] ?? {};
        if (record.last_fired_minute === minute) continue;
        let schedule;
        try { schedule = parseSchedule(task.schedule); } catch { continue; }
        if (!matches(schedule, new Date(minute))) continue;
        history[task.id] = { ...record, last_fired_minute: minute };
        changed = true;
        ready.push(task);
      }
      // Claimed before the first run starts, so a slow task cannot be fired twice by the
      // following tick, and a crash mid-run does not replay it on restart.
      if (changed) await this.#writeHistory(history);
      return ready;
    });
  }

  /** Keep only the newest success and the newest failure, discarding everything else. */
  record(taskId, entry) {
    return this.#serial(async () => {
      const history = await this.#readHistory();
      const record = history[String(taskId)] ?? {};
      const trimmed = {
        started_at: entry.started_at,
        finished_at: entry.finished_at,
        duration_ms: Math.max(0, entry.finished_at - entry.started_at),
        status: entry.status,
        ...(entry.output ? { output: truncate(entry.output) } : {}),
        ...(entry.error ? { error: truncate(entry.error, 2_000) } : {}),
      };
      history[String(taskId)] = { ...record, [entry.status === "success" ? "success" : "failure"]: trimmed };
      await this.#writeHistory(history);
      return trimmed;
    });
  }
}

function validate(input) {
  const name = String(input.name ?? "").trim();
  if (!name || name.length > 120) throw new Error("task name must contain 1 to 120 characters");
  const description = String(input.description ?? "").trim().slice(0, 2_000);
  const schedule = String(input.schedule ?? "").trim();
  parseSchedule(schedule);
  const skills = [...new Set((Array.isArray(input.skills) ? input.skills : [])
    .map((skill) => String(skill ?? "").trim()).filter(Boolean))].slice(0, 25);
  const starts_at = timestamp(input.starts_at, "start time");
  const ends_at = timestamp(input.ends_at, "end time");
  if (starts_at && ends_at && ends_at <= starts_at) throw new Error("end time must be after start time");
  return { name, description, schedule, skills, starts_at, ends_at, enabled: input.enabled !== false };
}

function timestamp(value, label) {
  if (value === null || value === undefined || value === "") return null;
  const at = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(at)) throw new Error(`${label} is not a valid date`);
  return at;
}

function truncate(text, limit = MAX_OUTPUT_BYTES) {
  const value = String(text ?? "");
  return value.length > limit ? `${value.slice(0, limit)}\n… truncated` : value;
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

async function atomicJson(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, path);
}

/**
 * The prompt a scheduled task is given.
 *
 * It says plainly that nobody is listening, because the failure mode of an unattended
 * session is a model that asks a clarifying question and then waits forever.
 */
export function taskPrompt(task) {
  const lines = [
    "You are running a scheduled task. This session is unattended: no one will read a",
    "question or answer one, and nothing you say is delivered to a person. Work autonomously",
    "and finish in this single turn.",
    "",
    `Task: ${task.name}`,
  ];
  if (task.description) lines.push(`Description: ${task.description}`);
  lines.push(`Schedule: ${task.schedule} (UTC)`);
  if (task.skills?.length) lines.push(`Skills available to you: ${task.skills.join(", ")}`);
  lines.push("", "Carry out the task now, then finish with a short report of what you did and what",
    "the result was. Do not include credentials or secret values in the report.");
  return lines.join("\n");
}

/**
 * The cron lane.
 *
 * Scheduled runs are deliberately outside `config.capacity` — a nightly job must not be
 * refused because someone is chatting — but they get a bound of their own so ten tasks
 * sharing a midnight schedule cannot open ten Pi sessions at once. Work over the bound
 * waits its turn rather than being dropped: a daily task that lost its slot would
 * otherwise lose the whole day.
 */
export class CronScheduler {
  #running = new Set();
  // Tasks waiting for a slot, oldest first. One entry per task: a schedule that fires
  // faster than it runs must not stack up copies of itself.
  #queue = [];
  #timer = null;

  constructor(store, runtime, logger, options = {}) {
    this.store = store;
    this.runtime = runtime;
    this.logger = logger;
    this.limit = Math.max(1, Number(options.limit) || 3);
    this.queueLimit = Math.max(1, Number(options.queueLimit) || 100);
    this.intervalMs = Math.max(5_000, Number(options.intervalMs) || 30_000);
  }

  get active() { return this.#running.size; }
  get queued() { return this.#queue.length; }

  /**
   * The task list, annotated with what the lane is doing right now.
   *
   * A run reports itself only through history, which lands when it is over. Without this
   * a task triggered by hand looks inert for however long it takes.
   */
  async list() {
    const { items } = await this.store.list();
    return {
      items: items.map((task) => ({
        ...task,
        running: this.#running.has(task.id),
        waiting: this.#queue.some((item) => item.id === task.id),
      })),
    };
  }

  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick().catch((error) => this.logger?.log("warning", "cron tick failed", { error: String(error) }));
    }, this.intervalMs);
    this.#timer.unref?.();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * Submit everything the schedule names for this minute.
   *
   * Resolves once all of it has run, queue time included, so a caller can wait for the
   * tick to settle rather than guess at it.
   */
  async tick(now = Date.now()) {
    const due = await this.store.due(now);
    return Promise.all(due.map((task) => this.#submit(task)).filter(Boolean));
  }

  /**
   * Run one task now, whatever its schedule says.
   *
   * Returns as soon as the run has started, or been queued behind one. A task can take
   * minutes, and the caller is a 15-second RPC from the control plane: the result belongs
   * in the history, not in the reply.
   */
  async runNow(taskId) {
    const task = await this.store.get(taskId);
    if (!task) throw new Error("no such scheduled task");
    const queued = this.#running.size >= this.limit;
    const pending = this.#submit(task);
    if (!pending) throw new Error("this task is already running or waiting for a slot");
    void pending;
    return { started: !queued, queued };
  }

  /** Join the queue, then take a slot if one is free. Null if it is already pending. */
  #submit(task) {
    if (this.#running.has(task.id) || this.#queue.some((item) => item.id === task.id)) {
      this.logger?.log("info", "scheduled task is still running from its last firing", { task_id: task.id, name: task.name });
      return null;
    }
    if (this.#queue.length >= this.queueLimit) {
      this.logger?.log("warning", "scheduled task dropped: the cron queue is full", { task_id: task.id, name: task.name, queue_limit: this.queueLimit });
      return null;
    }
    const waiting = new Promise((settle) => this.#queue.push({ id: task.id, name: task.name, settle }));
    this.#drain();
    return waiting;
  }

  #drain() {
    while (this.#queue.length && this.#running.size < this.limit) {
      const item = this.#queue.shift();
      // Reserved before the first await, or the whole queue would claim the same slot.
      this.#running.add(item.id);
      void this.#dispatch(item);
    }
  }

  async #dispatch(item) {
    let result = null;
    try { result = await this.run(item.id); }
    catch (error) { this.logger?.log("error", "scheduled task could not be started", { task_id: item.id, name: item.name, error: String(error) }); }
    finally {
      this.#running.delete(item.id);
      item.settle(result);
      this.#drain();
    }
  }

  /**
   * Execute one task and record what happened.
   *
   * The task is re-read rather than taken from the queue entry: it may have been edited,
   * paused, or deleted while it waited, and the version that runs should be the one that
   * stands now.
   */
  async run(taskId) {
    const task = await this.store.get(taskId);
    if (!task || !task.enabled) {
      this.logger?.log("info", "scheduled task skipped: it was removed or paused while it waited", { task_id: taskId });
      return null;
    }
    if (task.ends_at && Date.now() > task.ends_at) {
      this.logger?.log("info", "scheduled task skipped: its window closed while it waited", { task_id: task.id, name: task.name });
      return null;
    }
    const started_at = Date.now();
    this.logger?.log("info", "scheduled task started", { task_id: task.id, name: task.name });
    try {
      const output = await this.runtime.runTask({ id: task.id, prompt: taskPrompt(task), skills: task.skills ?? [] });
      const entry = await this.store.record(task.id, { started_at, finished_at: Date.now(), status: "success", output });
      this.logger?.log("info", "scheduled task finished", { task_id: task.id, name: task.name, duration_ms: entry.duration_ms });
      return entry;
    } catch (error) {
      const entry = await this.store.record(task.id, { started_at, finished_at: Date.now(), status: "error", error: String(error) });
      this.logger?.log("error", "scheduled task failed", { task_id: task.id, name: task.name, error: String(error) });
      return entry;
    }
  }
}
