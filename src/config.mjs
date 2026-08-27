import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadEnvFile, readEnvFile, writeEnvFile } from "./dotenv.mjs";

const DEFAULT_WORKDIR = "/var/lib/zidane-agent";

export function configFromEnv(env = process.env) {
  const workingDirectory = resolve(env.ZIDANE_AGENT_WORKING_DIRECTORY ?? DEFAULT_WORKDIR);
  const capacity = Number.parseInt(env.ZIDANE_AGENT_CAPACITY ?? "5", 10);
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error("ZIDANE_AGENT_CAPACITY must be >= 1");
  const apiKey = env.ZIDANE_AGENT_API_KEY ?? "";
  const serverUrl = env.ZIDANE_AGENT_SERVER_URL ?? "";
  if (!apiKey || !serverUrl) throw new Error("ZIDANE_AGENT_API_KEY and ZIDANE_AGENT_SERVER_URL are required");
  const parsedServer = new URL(serverUrl);
  if (!["ws:", "wss:"].includes(parsedServer.protocol)) throw new Error("ZIDANE_AGENT_SERVER_URL must use ws or wss");
  const localNames = new Set(["localhost", "127.0.0.1", "::1", "backend", "zidane-backend"]);
  if (parsedServer.protocol !== "wss:" && !localNames.has(parsedServer.hostname) && env.ZIDANE_AGENT_ALLOW_INSECURE_WS !== "true") {
    throw new Error("remote Zidane servers require wss (set ZIDANE_AGENT_ALLOW_INSECURE_WS=true only on a trusted network)");
  }
  return {
    name: env.ZIDANE_AGENT_NAME ?? "zidane-agent",
    version: env.ZIDANE_AGENT_VERSION ?? "1.0.0",
    description: env.ZIDANE_AGENT_DESCRIPTION ?? "Autonomous Pi coding agent",
    apiKey, serverUrl, capacity, workingDirectory,
  };
}

export function paths(config) {
  const root = config.workingDirectory;
  return {
    root, agent: resolve(root, "agent.json"), soul: resolve(root, "SOUL.md"),
    skills: resolve(root, "skills"), memory: resolve(root, "memory"),
    knowledge: resolve(root, "knowledge"), config: resolve(root, "config"),
    configMaps: resolve(root, "config-maps"),
    sessions: resolve(root, "sessions"),
    auth: resolve(root, "auth"),
    workspaces: resolve(root, "workspaces"), exports: resolve(root, "exports"),
    logs: resolve(root, "logs"), token: resolve(root, "auth", "session-token"),
  };
}

export async function initialise(config) {
  const local = paths(config);
  await Promise.all(Object.values(local).filter((value) => !value.endsWith(".json") && !value.endsWith(".md") && !value.endsWith("session-token"))
    .map((value) => mkdir(value, { recursive: true })));
  await chmod(local.root, 0o700);
  await chmod(local.auth, 0o700);
  await migrateSecretLayout(local);
  process.env.ZIDANE_AGENT_CONFIG_FILE = resolve(local.config, "applied.json");
  // Where a skill or tool should look for agent-owned state. Set before the applied
  // config is replayed below, and reserved from it, so a config map cannot redirect
  // a skill to a directory of its own choosing.
  process.env.AI_AGENT_CONFIG_MAPS_FOLDER = local.configMaps;
  await loadEnvFile(local);
  try {
    const applied = JSON.parse(await readFile(process.env.ZIDANE_AGENT_CONFIG_FILE, "utf8"));
    for (const [key, value] of Object.entries(applied.values ?? {})) {
      if (isRuntimeEnvironmentKey(key)) process.env[key] = String(value);
    }
  } catch { /* no previously applied state */ }
  try {
    const stored = JSON.parse(await readFile(local.agent, "utf8"));
    if (typeof stored.name === "string" && stored.name.trim()) config.name = stored.name.trim();
    if (typeof stored.description === "string") config.description = stored.description;
    if (Number.isInteger(stored.capacity) && stored.capacity >= 1) config.capacity = stored.capacity;
  } catch {
    await atomicJson(local.agent, {
      name: config.name,
      version: config.version,
      description: config.description,
      capacity: config.capacity,
    });
  }
  try { await readFile(local.soul); } catch {
    await writeFile(local.soul, "# Soul\n\nBe helpful, candid, safe, and respectful.\n");
  }
  return local;
}

export async function readSessionToken(local) {
  try { return (await readFile(local.token, "utf8")).trim(); } catch { return ""; }
}

export async function writeSessionToken(local, token) {
  await mkdir(dirname(local.token), { recursive: true });
  const pending = `${local.token}.new`;
  await writeFile(pending, token, { mode: 0o600 });
  await rename(pending, local.token);
  await chmod(local.token, 0o600);
}

export async function clearSessionToken(local) {
  await rm(local.token, { force: true });
}

export async function applyAgentInfo(local, config, message) {
  const name = String(message.name ?? "").trim();
  const description = String(message.description ?? "").trim();
  const capacity = Number(message.capacity);
  if (!name || name.length > 120) throw new Error("agent name must contain 1 to 120 characters");
  if (description.length > 2_000) throw new Error("agent description exceeds 2000 characters");
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1_000) {
    throw new Error("agent capacity must be between 1 and 1000");
  }
  config.name = name;
  config.description = description;
  config.capacity = capacity;
  await atomicJson(local.agent, {
    name,
    version: config.version,
    description,
    capacity,
  });
  return { name, description, capacity };
}



/**
 * Apply the control plane's desired state.
 *
 * `values` are ordinary configuration; `secretValues` are written to `config-maps/.env`
 * and merged into the environment, which is the only place a secret value ever lives.
 */
export async function applyState(local, revision, values, secretValues) {
  await applyConfigValues(local, revision, values);
  await applySecretValues(local, secretValues);
}

/** Resolve one secret value by name. The environment is the single lookup. */
export function readSecretValue(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name ?? ""))) throw new Error(`unsafe secret value name: ${name}`);
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`no value for ${name}; set it in the environment or config-maps/.env`);
  return value;
}

export async function applySecretValues(local, secretValues) {
  const incoming = {};
  for (const [key, value] of Object.entries(secretValues ?? {})) {
    if (!isRuntimeEnvironmentKey(key)) throw new Error(`reserved secret value name: ${key}`);
    incoming[key] = String(value ?? "");
  }
  const stored = await readEnvFile(local);
  const appliedPath = resolve(local.config, "applied-secrets.json");
  let previous = [];
  try { previous = JSON.parse(await readFile(appliedPath, "utf8")); } catch { /* first application */ }
  if (!Array.isArray(previous)) previous = Object.keys(previous ?? {});
  // A key this revision drops is removed from the file, and from the environment if
  // that is where it came from.
  for (const key of previous) {
    if (key in incoming) continue;
    delete stored[key];
    if (process.env[key] !== undefined && !(key in incoming)) delete process.env[key];
  }
  Object.assign(stored, incoming);
  await writeEnvFile(local, stored);
  for (const [key, value] of Object.entries(incoming)) process.env[key] = value;
  await atomicJson(appliedPath, Object.keys(incoming).sort(), 0o600);
}

export async function applyConfigValues(local, revision, values) {
  const cleanValues = Object.fromEntries(
    Object.entries(values ?? {})
      .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key))
      .map(([key, value]) => [key, String(value)]),
  );
  const appliedPath = resolve(local.config, "applied.json");
  let previousValues = {};
  try { previousValues = JSON.parse(await readFile(appliedPath, "utf8")).values ?? {}; } catch { /* first application */ }
  for (const key of Object.keys(previousValues)) {
    if (isRuntimeEnvironmentKey(key) && !(key in cleanValues)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(cleanValues)) {
    if (isRuntimeEnvironmentKey(key)) process.env[key] = value;
  }
  await atomicJson(appliedPath, { revision, values: cleanValues });
}


/** A secret is a named directory of mode-0600 key files, mirroring a config map. */
/**
 * Retire the separate secret store.
 *
 * Secrets used to be their own kind, kept in `secrets/` beside the agent's own
 * credentials. They are now just the named values a config map declares, resolved from
 * the environment, so the store is removed outright — the operator provisions the
 * values through the deployment or `config-maps/.env`.
 */
async function migrateSecretLayout(local) {
  for (const name of ["session-token", "pi-auth.json"]) {
    try { await rename(resolve(local.root, "secrets", name), resolve(local.auth, name)); }
    catch { /* already moved, or never existed */ }
  }
  let entries = [];
  try { entries = await readdir(resolve(local.root, "secrets"), { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.startsWith("knowledge-")) {
      try { await rename(resolve(local.root, "secrets", entry.name), resolve(local.auth, entry.name)); }
      catch { /* already moved */ }
    }
  }
  await rm(resolve(local.root, "secrets"), { recursive: true, force: true });
}



/**
 * Apply the control plane's desired secret state.
 *
 * Every entry it writes is marked `sync: true`, which is what tells the agent-owned
 * store that the control plane, not the user, is responsible for the copy.
 */





function isRuntimeEnvironmentKey(key) {
  return (
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    && !key.startsWith("ZIDANE_")
    && !key.startsWith("AI_AGENT_")
  );
}

async function atomicJson(target, value, mode = 0o644) {
  const pending = `${target}.new`;
  await writeFile(pending, JSON.stringify(value, null, 2), { mode });
  await rename(pending, target);
}

/** Read one key out of an agent-owned secret directory. */


/**
 * Resolve the profile a prompt should run under.
 *
 * The agent owns its profiles, so the server sends at most an id; everything else is
 * read from disk here. A pre-relay agent stored the whole profile in the default
 * pointer file, which still reads correctly.
 */
export async function resolveLlmProfile(local, profileId) {
  const directory = resolve(local.config, "llm-profiles");
  const load = async (id) => JSON.parse(await readFile(resolve(directory, `${id}.json`), "utf8"));
  if (profileId) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(profileId)) throw new Error("unsafe LLM profile id");
    return load(profileId);
  }
  let pointer;
  try { pointer = JSON.parse(await readFile(resolve(local.config, "default-llm-profile.json"), "utf8")); }
  catch { return {}; }
  if (pointer.profile_id) {
    try { return await load(String(pointer.profile_id)); } catch { return {}; }
  }
  return pointer.provider ? pointer : {};
}

export async function applyResource(local, kind, name, content) {
  const safeName = String(name).replace(/[^a-z0-9_-]/gi, "-").replace(/^-+|-+$/g, "");
  if (!safeName && kind !== "soul") throw new Error("resource name is required");
  const payload = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  let target;
  if (kind === "soul") target = local.soul;
  else if (kind === "skill") {
    target = resolve(local.skills, safeName, "SKILL.md");
    await mkdir(dirname(target), { recursive: true });
  } else if (kind === "memory") target = resolve(local.memory, `${safeName}.json`);
  else if (kind === "knowledge") target = resolve(local.knowledge, `${safeName}.json`);
  else throw new Error(`unsupported resource type: ${kind}`);
  await writeFile(target, payload, { mode: kind === "memory" ? 0o600 : 0o644 });
  return target;
}
