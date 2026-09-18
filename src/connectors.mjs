/**
 * Connectors — a skill and a config map bound together in one folder.
 *
 * ```text
 * connectors/<name>/
 *   SKILL.md      the procedure. Pi reads it; `$name` invokes it
 *   config.json   the declaration. Values, secret names, verify, expiry
 *   .zidane.json  identity, source and timestamps, as skills already have
 *   status.json   the last verify result. Local to this agent, never exported
 * ```
 *
 * Nothing here is a new mechanism. `discoverSkills` already walks a tree looking for
 * `<dir>/SKILL.md` beside a `.zidane.json`, which is exactly this shape, so adding
 * `connectors/` to a session's skill paths is the whole integration: the procedure is
 * found, described and invoked by the machinery skills already use. `config.json` is
 * the document a config map stores, so its values reach the environment down the same
 * path and export to a branch under the same rule — a secret travels by name only.
 *
 * What a connector adds is the half of the contract the pairing never had: a health
 * check that can be run without asking a model anything, and an expiry.
 */

import { execFile } from "node:child_process";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { readEnvFile, writeEnvFile, SAFE_ENV_KEY } from "./dotenv.mjs";
import { skillIdentity, withSkillIdentity } from "./agent-data.mjs";
import { sandboxEnvironment, sandboxPaths } from "./sandbox.mjs";

const run = promisify(execFile);

/** A directory name, and also a `$command` name, so it stays narrow. */
export const SAFE_CONNECTOR_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const INTERPOLATION = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const MAX_CONTENT_BYTES = 1_000_000;
const MAX_DETAIL = 2_000;
const DEFAULT_TIMEOUT_SECONDS = 20;
const MAX_TIMEOUT_SECONDS = 120;
const MAX_VALUES = 100;

/**
 * Three states, not two.
 *
 * `unconfigured` is the honest answer for a connector whose token was never set, and
 * for a probe that names a value nothing supplies. Reporting that as a failure would
 * page somebody about a connector nobody has finished adding; reporting it as a pass
 * would be a green light that proves nothing.
 */
export const PASS = "pass";
export const FAIL = "fail";
export const UNCONFIGURED = "unconfigured";

/**
 * Substitute `${NAME}` from the supplied values.
 *
 * Reports what was missing rather than interpolating an empty string: a probe whose
 * URL lost its host does not fail usefully, it fails confusingly.
 */
export function interpolate(template, values) {
  const missing = new Set();
  const text = String(template ?? "").replace(INTERPOLATION, (_match, key) => {
    const value = values[key];
    if (value === undefined || value === "") {
      missing.add(key);
      return "";
    }
    return String(value);
  });
  return { text, missing: [...missing].sort() };
}

/** Every `${NAME}` a verify block mentions, in the order a human would read them. */
export function referencedValues(verify) {
  const names = new Set();
  for (const match of JSON.stringify(verify ?? {}).matchAll(INTERPOLATION)) names.add(match[1]);
  return [...names].sort();
}

/**
 * Remove anything that must not reach a console.
 *
 * A failing `curl` echoes request headers, and an authenticating proxy sometimes hands
 * the credential back in its error body. The status is displayed, so it is redacted at
 * the point it is made rather than wherever it is eventually rendered: the connector's
 * own secret values by exact match, then the same key-shaped discipline `sanitise`
 * applies to Pi events.
 */
export function redact(text, secrets = []) {
  let output = String(text ?? "");
  for (const value of secrets) {
    // A one or two character value would turn the whole string into redaction markers.
    if (typeof value === "string" && value.length >= 4) output = output.split(value).join("[redacted]");
  }
  return output
    // The scheme word has to be consumed with the value, not instead of it: matching
    // `Authorization: ` and stopping at the first space redacts the word `Bearer` and
    // leaves the credential standing in the clear.
    .replace(
      /((?:api[-_]?key|authorization|secret|token|password)["']?\s*[:=]\s*["']?)(?:(?:Bearer|Basic|Token)\s+)?[^\s"',;]+/gi,
      "$1[redacted]",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
    .slice(0, MAX_DETAIL);
}

/**
 * What the expiry date says today.
 *
 * Most tokens do not announce when they expire, so `at` is usually just what somebody
 * typed when they pasted one in. That is still worth having — it is the difference
 * between a warning and an outage — but it is never the reason a connector is failing,
 * so it is reported beside the verify state rather than folded into it.
 */
export function expiryState(expires, now = Date.now()) {
  const at = Date.parse(expires?.at ?? "");
  if (!Number.isFinite(at)) return { state: "unknown", days_left: null, at: null };
  const warnDays = Number.isFinite(Number(expires?.warn_days)) ? Number(expires.warn_days) : 7;
  const daysLeft = Math.floor((at - now) / 86_400_000);
  const state = daysLeft < 0 ? "expired" : daysLeft <= warnDays ? "warn" : "ok";
  return { state, days_left: daysLeft, at: new Date(at).toISOString() };
}

function timeoutMs(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_SECONDS * 1_000;
  return Math.min(value, MAX_TIMEOUT_SECONDS) * 1_000;
}

/**
 * Run one declarative HTTP probe.
 *
 * Declarative by default because verify runs unattended on a timer: a probe that is
 * data can be read before it runs, cannot be talked into doing something else, and
 * answers with a status code rather than an opinion.
 */
async function probeHttp(http, values, secrets) {
  const url = interpolate(http.url, values);
  if (!/^https?:\/\//i.test(url.text)) {
    return { state: FAIL, detail: "the probe URL must be an absolute http(s) URL" };
  }
  const headers = { ...(http.headers ?? {}) };
  for (const [key, value] of Object.entries(headers)) headers[key] = interpolate(value, values).text;
  const auth = http.auth ?? {};
  if (auth.type === "basic") {
    const user = interpolate(auth.username, values).text;
    const password = interpolate(auth.password, values).text;
    headers.Authorization = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  } else if (auth.type === "bearer") {
    headers.Authorization = `Bearer ${interpolate(auth.token, values).text}`;
  }
  const expected = Number(http.expect_status) || 200;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs(http.timeout_seconds));
  try {
    const response = await fetch(url.text, {
      method: String(http.method ?? "GET").toUpperCase(),
      headers,
      redirect: "follow",
      signal: controller.signal,
    });
    if (response.status === expected) {
      return { state: PASS, status_code: response.status, detail: `${response.status} from ${hostOf(url.text)}` };
    }
    // The body is the only place a service explains itself, and it is also the likeliest
    // place for the credential to come back — so it is read, truncated, and redacted.
    const body = redact(await response.text().catch(() => ""), secrets).slice(0, 400).trim();
    return {
      state: response.status === 401 || response.status === 403 ? FAIL : FAIL,
      status_code: response.status,
      detail: `expected ${expected}, got ${response.status} from ${hostOf(url.text)}${body ? `: ${body}` : ""}`,
    };
  } catch (error) {
    const reason = error?.name === "AbortError" ? "timed out" : String(error?.message ?? error);
    return { state: FAIL, detail: redact(`${hostOf(url.text)}: ${reason}`, secrets) };
  } finally {
    clearTimeout(timer);
  }
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return "the configured host"; }
}

/**
 * Run one shell probe.
 *
 * The escape hatch for a credential with no HTTP probe — `gh auth status` is the reason
 * it exists. It runs with the session sandbox's environment so `$HOME` is the shared,
 * durable one a tool was configured in, and in a throwaway workspace so it can write
 * nowhere durable of its own.
 */
async function probeShell(shell, workspace, home, secrets) {
  const command = String(shell.command ?? "").trim();
  if (!command) return { state: FAIL, detail: "the probe declares no command" };
  const paths = sandboxPaths(workspace, home);
  await mkdir(paths.tmp, { recursive: true });
  await mkdir(paths.home, { recursive: true });
  try {
    const { stdout, stderr } = await run("/bin/sh", ["-c", command], {
      cwd: paths.workspace,
      env: sandboxEnvironment(process.env, paths),
      timeout: timeoutMs(shell.timeout_seconds),
      maxBuffer: 1_000_000,
    });
    return { state: PASS, detail: redact(`${stdout}${stderr}`.trim() || "exited 0", secrets) };
  } catch (error) {
    const detail = error?.killed
      ? "timed out"
      : `${error?.stdout ?? ""}${error?.stderr ?? ""}`.trim() || String(error?.message ?? error);
    return { state: FAIL, status_code: error?.code ?? null, detail: redact(detail, secrets) };
  }
}

/**
 * Check one connector's credential.
 *
 * Every value the probe names must resolve before anything is sent: an unset token is
 * `unconfigured`, which is neither a failure to chase nor a pass to trust.
 */
export async function runProbe(record, { values, workspace, home }) {
  const verify = record.verify ?? {};
  const started = Date.now();
  const base = { checked_at: new Date(started).toISOString(), state: UNCONFIGURED, status_code: null, detail: "" };
  if (!verify.http && !verify.shell) {
    return { ...base, detail: "this connector declares no health check" };
  }
  const missing = referencedValues(verify).filter((key) => values[key] === undefined || values[key] === "");
  if (missing.length) {
    return { ...base, detail: `not checked: no value for ${missing.join(", ")}`, missing };
  }
  const secrets = (record.secret_values ?? []).map((key) => values[key]).filter(Boolean);
  const outcome = verify.http
    ? await probeHttp(verify.http, values, secrets)
    : await probeShell(verify.shell, workspace, home, secrets);
  return { ...base, ...outcome, duration_ms: Date.now() - started };
}

/** Agent-owned CRUD for connectors, plus the health check they exist to carry. */
export class ConnectorStore {
  #pending = Promise.resolve();

  /**
   * @param local      the working-directory layout from `config.mjs#paths`
   * @param foreignClaims  async () => Map<valueName, ownerLabel> for everything that is
   *                       not a connector. One namespace reaches `process.env`, so a
   *                       name may have exactly one owner; see `#claim`.
   */
  constructor(local, foreignClaims = async () => new Map()) {
    this.local = local;
    this.foreignClaims = foreignClaims;
  }

  /** Serialised like the agent data store: two writes must not interleave on disk. */
  handle(operation, input = {}) {
    const task = this.#pending.then(() => this.#execute(String(operation ?? ""), input));
    this.#pending = task.catch(() => undefined);
    return task;
  }

  async #execute(operation, input) {
    if (operation === "connector.list") return { items: (await this.list()).map(publicConnector) };
    if (operation === "connector.get") return { item: publicConnector(await this.#require(input.connector_id), { includeContent: true }) };
    if (operation === "connector.create") return { item: publicConnector(await this.create(input), { includeContent: true }) };
    if (operation === "connector.update") return { item: publicConnector(await this.update(input), { includeContent: true }) };
    if (operation === "connector.delete") return { deleted: await this.remove(input.connector_id) };
    if (operation === "connector.verify") return { item: publicConnector(await this.verify(input.connector_id), { includeContent: false }) };
    throw new Error(`unsupported connector operation: ${operation}`);
  }

  #directory(name) {
    const target = resolve(this.local.connectors, validConnectorName(name));
    if (dirname(target) !== this.local.connectors) throw new Error("connector path escapes the store");
    return target;
  }

  async list() {
    await mkdir(this.local.connectors, { recursive: true });
    const items = [];
    for (const entry of await readdir(this.local.connectors, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SAFE_CONNECTOR_NAME.test(entry.name)) continue;
      const item = await this.#read(entry.name);
      if (item) items.push(item);
    }
    return items.sort((left, right) => left.name.localeCompare(right.name));
  }

  async #read(name) {
    const directory = this.#directory(name);
    const record = await readJson(resolve(directory, "config.json"), null);
    if (!record) return null;
    let content = "";
    let updatedAt = Number(record.updated_at) || 0;
    try {
      content = await readFile(resolve(directory, "SKILL.md"), "utf8");
      updatedAt = Math.max(updatedAt, Math.floor((await stat(resolve(directory, "SKILL.md"))).mtimeMs));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const metadata = await readJson(resolve(directory, ".zidane.json"), null);
    const status = await readJson(resolve(directory, "status.json"), null);
    // The file outranks the sidecar, exactly as a skill's identity does: a restored or
    // promoted copy re-links to its account row rather than appearing twice.
    const id = skillIdentity(content) || (SAFE_ID.test(String(metadata?.id ?? "")) ? String(metadata.id) : "");
    return { ...storedConnector(name, record), id, content, status, updated_at: updatedAt };
  }

  async #require(nameValue) {
    const item = await this.#read(validConnectorName(nameValue));
    if (!item) throw new Error("connector not found");
    return item;
  }

  /**
   * Refuse a value name something else already owns.
   *
   * Connector values and config-map values reach one `process.env`, so a skill reads
   * `$JIRA_TOKEN` without knowing which kind supplied it. That is worth keeping simple,
   * and it makes this rule necessary: last-write-wins across two owners is a silent,
   * order-dependent failure, and it is the kind that surfaces at 03:00.
   *
   * Jira and Confluence are separate connectors for this reason rather than in spite of
   * it — they namespace their values instead of sharing one.
   */
  async #claim(name, values) {
    const claims = new Map(await this.foreignClaims());
    for (const item of await this.list()) {
      if (item.name === name) continue;
      for (const key of valueNames(item)) claims.set(key, `the ${item.name} connector`);
    }
    for (const key of values) {
      const owner = claims.get(key);
      if (owner) throw new Error(`${key} is already provided by ${owner}; give this connector a value name of its own`);
    }
  }

  /** Ordinary values go straight to the environment; secret values go through `.env`. */
  async #applyValues(record, secretEntries) {
    for (const [key, value] of Object.entries(record.normal_values)) process.env[key] = String(value);
    if (!secretEntries || typeof secretEntries !== "object" || Array.isArray(secretEntries)) return;
    const stored = await readEnvFile(this.local);
    let changed = false;
    for (const [key, value] of Object.entries(secretEntries)) {
      assertValueName(key);
      if (value === null) continue;
      stored[key] = String(value);
      process.env[key] = String(value);
      changed = true;
    }
    if (changed) await writeEnvFile(this.local, stored);
  }

  /**
   * Re-assert every connector's ordinary values into the environment.
   *
   * Secret values arrive from `config-maps/.env` at startup; ordinary ones live in the
   * records, so they are replayed from there on the way up.
   */
  /** Every value name a connector owns, so a config map can be refused the same way. */
  async valueClaims() {
    const claims = new Map();
    for (const item of await this.list()) {
      for (const key of valueNames(item)) claims.set(key, `the ${item.name} connector`);
    }
    return claims;
  }

  async apply() {
    const items = await this.list();
    for (const item of items) {
      for (const [key, value] of Object.entries(item.normal_values)) process.env[key] = String(value);
    }
    return { count: items.length };
  }

  async create(input) {
    const name = validConnectorName(input.name);
    if (await this.#read(name)) throw new Error("a connector with this name already exists");
    const record = connectorRecord(null, input);
    await this.#claim(name, valueNames(record));
    const content = validContent(input.content);
    const declared = skillIdentity(content);
    const taken = new Set((await this.list()).map((item) => item.id));
    const id = declared && !taken.has(declared) ? declared : crypto.randomUUID();
    await this.#write(name, id, record, content, input);
    await this.#applyValues(record, input.secret_entries);
    return this.#require(name);
  }

  async update(input) {
    const current = await this.#require(input.connector_id);
    const name = validConnectorName(input.name ?? current.name);
    if (name !== current.name && await this.#read(name)) {
      throw new Error("a connector with this name already exists");
    }
    const record = connectorRecord(current, input);
    await this.#claim(name, valueNames(record));
    const content = input.content === undefined ? current.content : validContent(input.content);
    await this.#write(name, current.id, record, content, input);
    if (name !== current.name) await rm(this.#directory(current.name), { recursive: true, force: true });
    await this.#applyValues(record, input.secret_entries);
    // A renamed or re-declared connector's last result described a different question.
    if (name !== current.name) await rm(resolve(this.#directory(name), "status.json"), { force: true });
    return this.#require(name);
  }

  async #write(name, id, record, content, input) {
    const directory = this.#directory(name);
    await mkdir(directory, { recursive: true });
    const timestamp = Date.now();
    // Every write repairs the identity, so editing can neither drop one nor rebind it.
    await atomicFile(resolve(directory, "SKILL.md"), withSkillIdentity(content, id), 0o600);
    await atomicJson(resolve(directory, "config.json"), record, 0o600);
    await atomicJson(resolve(directory, ".zidane.json"), {
      id,
      name,
      source: validSource(input.source) ?? { scope: "agent" },
      created_at: record.created_at,
      updated_at: timestamp,
    }, 0o600);
  }

  async remove(nameValue) {
    const item = await this.#read(validConnectorName(nameValue));
    if (!item) return false;
    // The values leave with it: revoking a connector has to take its configuration off
    // the environment, or the next skill to name one silently keeps working.
    const stored = await readEnvFile(this.local);
    let changed = false;
    for (const key of item.secret_values) {
      if (key in stored) { delete stored[key]; changed = true; }
      delete process.env[key];
    }
    for (const key of Object.keys(item.normal_values)) delete process.env[key];
    if (changed) await writeEnvFile(this.local, stored);
    await rm(this.#directory(item.name), { recursive: true, force: true });
    return true;
  }

  /** Run the health check and record what it said. */
  async verify(nameValue) {
    const item = await this.#require(nameValue);
    const values = {};
    for (const key of new Set([...Object.keys(item.normal_values), ...item.secret_values, ...referencedValues(item.verify)])) {
      const value = process.env[key] ?? item.normal_values[key];
      if (value !== undefined) values[key] = String(value);
    }
    const outcome = await runProbe(item, {
      values,
      workspace: resolve(this.local.workspaces, `.verify-${item.name}`),
      home: this.local.home,
    });
    const previous = item.status?.state ?? null;
    const status = { ...outcome, previous_state: previous, changed: previous !== null && previous !== outcome.state };
    await atomicJson(resolve(this.#directory(item.name), "status.json"), status, 0o600);
    // The throwaway workspace is exactly that: a shell probe may have written to it.
    await rm(resolve(this.local.workspaces, `.verify-${item.name}`), { recursive: true, force: true });
    return { ...item, status };
  }
}

/**
 * What is worth telling somebody about.
 *
 * Only the edges, and only the two that mean something: a connector that was working
 * and now is not, and one that was broken and now is not. A connector that has been
 * failing for three days is still failing, and saying so every six hours trains people
 * to ignore it.
 *
 * `unconfigured` never notifies. Nobody finished adding it; that is not an incident.
 */
export function transitionOf(previous, state) {
  if (state === FAIL && previous !== FAIL) return "failed";
  if (state === PASS && previous === FAIL) return "recovered";
  return null;
}

/** Whether this connector is due a check, given when it was last looked at. */
export function isDue(item, now = Date.now()) {
  if (!item.verify?.http && !item.verify?.shell) return false;
  const last = Date.parse(item.status?.checked_at ?? "");
  if (!Number.isFinite(last)) return true;
  const minutes = Number(item.verify.interval_minutes) || 360;
  return now - last >= minutes * 60_000;
}

/**
 * The timer that runs due health checks.
 *
 * The agent owns this, as it owns the crontab and its check-backs. The control plane
 * still has no scheduler and gains none here: it is told what changed, and only when
 * something changed.
 *
 * A check costs one HTTP request or one short command, so it runs outside
 * `config.capacity` — unlike a wake, nothing here speaks in a conversation or asks a
 * model anything. That is the point of keeping verify declarative.
 */
export class ConnectorWatcher {
  #timer = null;

  constructor(store, emit, logger, { intervalMs = 60_000, perTick = 3 } = {}) {
    this.store = store;
    this.emit = emit;
    this.logger = logger;
    this.intervalMs = intervalMs;
    this.perTick = perTick;
  }

  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick().catch((error) => this.logger?.log("warning", "connector check failed", { error: String(error) }));
    }, this.intervalMs);
    this.#timer.unref?.();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async tick(now = Date.now()) {
    const due = (await this.store.list()).filter((item) => isDue(item, now)).slice(0, this.perTick);
    const reported = [];
    for (const item of due) {
      const previous = item.status?.state ?? null;
      // Through `handle`, so a check cannot interleave with somebody editing the
      // connector it is checking.
      const { item: checked } = await this.store.handle("connector.verify", { connector_id: item.name });
      const transition = transitionOf(previous, checked.status.state);
      this.logger?.log("info", "connector checked", {
        connector: item.name, state: checked.status.state, previous, transition,
      });
      if (!transition) continue;
      this.emit?.("CONNECTOR_STATUS", {
        connector: item.name,
        title: checked.title,
        transition,
        state: checked.status.state,
        previous_state: previous,
        // Already redacted where it was made — see `redact`.
        detail: checked.status.detail,
        status_code: checked.status.status_code,
        checked_at: checked.status.checked_at,
        expiry: checked.expiry,
      });
      reported.push({ connector: item.name, transition });
    }
    return reported;
  }
}

function valueNames(item) {
  return [...new Set([...Object.keys(item.normal_values ?? {}), ...(item.secret_values ?? [])])];
}

function validConnectorName(value) {
  const name = String(value ?? "").trim();
  if (!SAFE_CONNECTOR_NAME.test(name)) throw new Error("connector name must be a safe 1 to 64 character key");
  return name;
}

function validContent(value) {
  const content = String(value ?? "");
  if (!content.trim() || Buffer.byteLength(content) > MAX_CONTENT_BYTES) {
    throw new Error("connector SKILL.md must contain 1 to 1000000 bytes");
  }
  return content;
}

function assertValueName(key) {
  if (!SAFE_ENV_KEY.test(key)) throw new Error(`unsafe value name: ${key}`);
  // The same reservation config maps get: a connector cannot repoint the folder
  // variables a skill uses to find the agent's own state.
  if (key.startsWith("ZIDANE_") || key.startsWith("AI_AGENT_")) throw new Error(`reserved value name: ${key}`);
  return key;
}

function validSource(source) {
  const scope = String(source?.scope ?? "");
  if (scope === "account" && SAFE_ID.test(String(source.id ?? ""))) return { scope, id: String(source.id) };
  if (scope === "catalog" && typeof source.template === "string" && source.template) {
    return { scope, template: source.template.slice(0, 120), version: String(source.version ?? "").slice(0, 40) };
  }
  if (scope === "agent") return { scope };
  return null;
}

/** The verify block, accepted only in the two shapes that can actually be run. */
function validVerify(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const interval = Number(value.interval_minutes);
  const common = { interval_minutes: Number.isFinite(interval) && interval >= 5 ? Math.min(interval, 10_080) : 360 };
  if (value.http && typeof value.http === "object") {
    const { method, url, headers, auth, expect_status, timeout_seconds } = value.http;
    if (typeof url !== "string" || !url.trim()) throw new Error("an http health check needs a url");
    return {
      ...common,
      http: {
        method: String(method ?? "GET").toUpperCase(),
        url: url.trim(),
        ...(headers && typeof headers === "object" && !Array.isArray(headers) ? { headers } : {}),
        ...(auth && typeof auth === "object" ? { auth } : {}),
        expect_status: Number(expect_status) || 200,
        timeout_seconds: Number(timeout_seconds) || DEFAULT_TIMEOUT_SECONDS,
      },
    };
  }
  if (value.shell && typeof value.shell === "object") {
    const command = String(value.shell.command ?? "").trim();
    if (!command) throw new Error("a shell health check needs a command");
    return { ...common, shell: { command, timeout_seconds: Number(value.shell.timeout_seconds) || DEFAULT_TIMEOUT_SECONDS } };
  }
  return null;
}

function validExpires(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const at = String(value.at ?? "").trim();
  if (at && !Number.isFinite(Date.parse(at))) throw new Error("the expiry date is not a date");
  const warnDays = Number(value.warn_days);
  return {
    at: at ? new Date(at).toISOString() : null,
    warn_days: Number.isFinite(warnDays) && warnDays >= 0 ? Math.min(warnDays, 365) : 7,
  };
}

function validValues(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("connector values must be an object");
  const entries = Object.entries(value);
  if (entries.length > MAX_VALUES) throw new Error(`a connector cannot declare more than ${MAX_VALUES} values`);
  const clean = {};
  for (const [key, item] of entries) clean[assertValueName(key)] = String(item);
  return clean;
}

function validSecretNames(declared, entries) {
  const names = new Set();
  for (const key of Array.isArray(declared) ? declared : []) names.add(assertValueName(String(key)));
  for (const key of Object.keys(entries ?? {})) names.add(assertValueName(key));
  if (names.size > MAX_VALUES) throw new Error(`a connector cannot declare more than ${MAX_VALUES} secret values`);
  return [...names].sort();
}

function connectorRecord(existing, input) {
  const timestamp = Date.now();
  const normal = validValues(input.normal_values ?? existing?.normal_values ?? {});
  const secrets = validSecretNames(input.secret_values ?? existing?.secret_values, input.secret_entries);
  for (const key of secrets) {
    if (key in normal) throw new Error(`${key} is declared as both an ordinary and a secret value`);
  }
  return {
    title: typeof input.title === "string" && input.title.trim() ? input.title.trim() : existing?.title ?? validConnectorName(input.name ?? existing?.name),
    description: typeof input.description === "string" ? input.description.slice(0, 2_000) : existing?.description ?? "",
    normal_values: normal,
    secret_values: secrets,
    verify: input.verify === undefined ? existing?.verify ?? null : validVerify(input.verify),
    expires: input.expires === undefined ? existing?.expires ?? null : validExpires(input.expires),
    source_id: input.source_id ?? existing?.source_id ?? null,
    created_at: existing?.created_at ?? timestamp,
    updated_at: timestamp,
  };
}

/** Normalise one stored record; unknown or malformed fields read as empty. */
function storedConnector(name, record) {
  const normal = record.normal_values && typeof record.normal_values === "object" && !Array.isArray(record.normal_values)
    ? record.normal_values
    : {};
  const secrets = Array.isArray(record.secret_values) ? record.secret_values.filter((key) => SAFE_ENV_KEY.test(String(key))) : [];
  return {
    name,
    title: typeof record.title === "string" && record.title.trim() ? record.title.trim() : name,
    description: typeof record.description === "string" ? record.description : "",
    normal_values: Object.fromEntries(Object.entries(normal).map(([key, value]) => [key, String(value)])),
    secret_values: [...new Set(secrets.map(String))].sort(),
    verify: record.verify && typeof record.verify === "object" ? record.verify : null,
    expires: record.expires && typeof record.expires === "object" ? record.expires : null,
    source_id: typeof record.source_id === "string" && record.source_id ? record.source_id : null,
    created_at: Number(record.created_at) || 0,
    updated_at: Number(record.updated_at) || 0,
  };
}

/**
 * A connector as the control plane sees it.
 *
 * Never a value: `secret_values` reports each declared name and whether something
 * resolves it right now, exactly as a config map does. The health check is reported
 * as data too — a console shows what would run, since that is the part a reviewer has
 * to be able to read before trusting it.
 */
export function publicConnector(item, { includeContent = false } = {}) {
  return {
    connector_id: item.name,
    id: item.id,
    name: item.name,
    title: item.title,
    description: item.description,
    ...(includeContent ? { content: item.content, normal_values: item.normal_values } : {}),
    normal_keys: Object.keys(item.normal_values).sort(),
    secret_values: item.secret_values.map((key) => ({ key, resolved: process.env[key] !== undefined && process.env[key] !== "" })),
    verify: item.verify ? { ...item.verify, kind: item.verify.http ? "http" : "shell" } : null,
    expiry: expiryState(item.expires),
    status: item.status
      ? {
        state: item.status.state,
        detail: item.status.detail,
        status_code: item.status.status_code ?? null,
        checked_at: item.status.checked_at,
        changed: item.status.changed === true,
      }
      : { state: UNCONFIGURED, detail: "never checked", status_code: null, checked_at: null, changed: false },
    source_id: item.source_id,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return fallback;
    throw error;
  }
}

async function atomicFile(target, contents, mode = 0o600) {
  await mkdir(dirname(target), { recursive: true });
  const pending = `${target}.new`;
  await writeFile(pending, contents, { mode });
  await rename(pending, target);
  await chmod(target, mode);
}

async function atomicJson(target, value, mode = 0o600) {
  await atomicFile(target, JSON.stringify(value, null, 2), mode);
}
