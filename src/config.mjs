import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DEFAULT_WORKDIR = "/var/lib/zidane-agent";

export function configFromEnv(env = process.env) {
  const workingDirectory = resolve(env.ZIDANE_AGENT_WORKING_DIRECTORY ?? DEFAULT_WORKDIR);
  const capacity = Number.parseInt(env.ZIDANE_AGENT_CAPACITY ?? "1", 10);
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
    secrets: resolve(root, "secrets"), sessions: resolve(root, "sessions"),
    syncedSecrets: resolve(root, "secrets", "synced"),
    workspaces: resolve(root, "workspaces"), exports: resolve(root, "exports"),
    logs: resolve(root, "logs"), token: resolve(root, "secrets", "session-token"),
  };
}

export async function initialise(config) {
  const local = paths(config);
  await Promise.all(Object.values(local).filter((value) => !value.endsWith(".json") && !value.endsWith(".md") && !value.endsWith("session-token"))
    .map((value) => mkdir(value, { recursive: true })));
  await chmod(local.root, 0o700);
  await chmod(local.secrets, 0o700);
  await chmod(local.syncedSecrets, 0o700);
  process.env.ZIDANE_AGENT_CONFIG_FILE = resolve(local.config, "applied.json");
  process.env.ZIDANE_AGENT_SYNCED_SECRETS_DIR = local.syncedSecrets;
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

export async function applyState(local, revision, values, secretValues) {
  await applyConfigValues(local, revision, values);
  await applySyncedSecrets(local, secretValues);
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

async function applySyncedSecrets(local, secretValues) {
  const nextSecrets = Object.keys(secretValues ?? {});
  const unsafeSecret = nextSecrets.find((name) => !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name));
  if (unsafeSecret) throw new Error(`unsafe secret name: ${unsafeSecret}`);
  const appliedSecretsPath = resolve(local.config, "applied-secrets.json");
  let previousSecrets = [];
  try { previousSecrets = JSON.parse(await readFile(appliedSecretsPath, "utf8")); } catch { /* first application */ }
  for (const name of previousSecrets) {
    if (!nextSecrets.includes(name) && /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) {
      await rm(resolve(local.syncedSecrets, name), { force: true });
    }
  }
  for (const [name, value] of Object.entries(secretValues ?? {})) {
    const target = resolve(local.syncedSecrets, name);
    if (dirname(target) !== local.syncedSecrets) throw new Error("secret path escapes state directory");
    await writeFile(target, String(value), { mode: 0o600 });
    await chmod(target, 0o600);
  }
  await atomicJson(appliedSecretsPath, nextSecrets, 0o600);
}

function isRuntimeEnvironmentKey(key) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !key.startsWith("ZIDANE_");
}

async function atomicJson(target, value, mode = 0o644) {
  const pending = `${target}.new`;
  await writeFile(pending, JSON.stringify(value, null, 2), { mode });
  await rename(pending, target);
}

export async function readSecret(local, name) {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) throw new Error("unsafe secret name");
  return (await readFile(resolve(local.secrets, name), "utf8")).trim();
}

export async function applyLlmProfile(local, profile) {
  const profileId = String(profile.profile_id ?? "");
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(profileId)) throw new Error("unsafe LLM profile id");
  const provider = String(profile.provider ?? "");
  const model = String(profile.model ?? "");
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(provider) || !model) {
    throw new Error("invalid LLM provider or model");
  }
  const secretName = `llm-profile-${profileId}`;
  const secretPath = resolve(local.secrets, secretName);
  if (profile.credential) {
    await writeFile(secretPath, String(profile.credential), { mode: 0o600 });
    await chmod(secretPath, 0o600);
  } else {
    await rm(secretPath, { force: true });
  }
  if (profile.base_url && profile.api) {
    const modelsPath = resolve(local.config, "models.json");
    let models;
    try { models = JSON.parse(await readFile(modelsPath, "utf8")); } catch { models = { providers: {} }; }
    models.providers ??= {};
    const configured = models.providers[provider] ?? {};
    const modelEntries = Array.isArray(configured.models) ? configured.models : [];
    if (!modelEntries.some((entry) => entry.id === model)) modelEntries.push({ id: model });
    models.providers[provider] = {
      ...configured,
      baseUrl: String(profile.base_url),
      api: String(profile.api),
      models: modelEntries,
    };
    await writeFile(modelsPath, JSON.stringify(models, null, 2), { mode: 0o600 });
  }
  const stored = {
    profile_id: profileId,
    name: String(profile.name ?? profileId),
    provider,
    model,
    secret_name: profile.credential ? secretName : null,
    base_url: profile.base_url ?? null,
    api: profile.api ?? null,
    thinking_level: profile.thinking_level ?? "medium",
    tools: Array.isArray(profile.tools) ? profile.tools : [],
  };
  const profileDirectory = resolve(local.config, "llm-profiles");
  await mkdir(profileDirectory, { recursive: true });
  await writeFile(resolve(profileDirectory, `${profileId}.json`), JSON.stringify(stored, null, 2), { mode: 0o600 });
  if (profile.set_default) {
    await writeFile(resolve(local.config, "default-llm-profile.json"), JSON.stringify(stored, null, 2), { mode: 0o600 });
  }
  return stored;
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
