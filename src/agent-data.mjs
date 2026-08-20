import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { applyConfigValues } from "./config.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const LLM_APIS = new Set(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const MAX_VALUE_BYTES = 1_000_000;

/** Agent-owned CRUD store for Pi skills, config maps, secrets, and LLM profiles. */
export class AgentDataStore {
  #pending = Promise.resolve();

  constructor(local) {
    this.local = local;
    this.configDirectory = resolve(local.config, "agent-config-maps");
    this.secretMetadata = resolve(local.config, "agent-secrets.json");
    this.profileDirectory = resolve(local.config, "llm-profiles");
    this.defaultProfileFile = resolve(local.config, "default-llm-profile.json");
  }

  handle(operation, input = {}) {
    const task = this.#pending.then(() => this.#execute(String(operation ?? ""), input));
    this.#pending = task.catch(() => undefined);
    return task;
  }

  async #execute(operation, input) {
    if (operation === "skill.list") return { items: await this.#listSkills() };
    if (operation === "skill.get") return { item: await this.#getSkill(input.skill_id) };
    if (operation === "skill.create") return { item: await this.#createSkill(input) };
    if (operation === "skill.update") return { item: await this.#updateSkill(input) };
    if (operation === "skill.delete") return { deleted: await this.#deleteSkill(input.skill_id) };
    if (operation === "skill.import") return { items: await this.#importSkills(input.items) };
    if (operation === "config.list") return { items: (await this.#loadConfigs()).map(publicConfigSummary) };
    if (operation === "config.get") return { item: await this.#getConfig(input.config_id) };
    if (operation === "config.create") return { item: await this.#createConfig(input) };
    if (operation === "config.update") return { item: await this.#updateConfig(input) };
    if (operation === "config.delete") return { deleted: await this.#deleteConfig(input.config_id) };
    if (operation === "config.import") return { items: await this.#importConfigs(input.items) };
    if (operation === "secret.list") return { items: (await this.#loadSecrets()).map(publicSecret) };
    if (operation === "secret.create") return { item: await this.#createSecret(input) };
    if (operation === "secret.update") return { item: await this.#updateSecret(input) };
    if (operation === "secret.delete") return { deleted: await this.#deleteSecret(input.secret_id) };
    if (operation === "secret.import") return { items: await this.#importSecrets(input.items) };
    if (operation === "llm.list") return { items: await this.#listProfiles() };
    if (operation === "llm.create") return { item: await this.#createProfile(input) };
    if (operation === "llm.update") return { item: await this.#updateProfile(input) };
    if (operation === "llm.delete") return { deleted: await this.#deleteProfile(input.profile_id) };
    if (operation === "llm.select") return { item: await this.#selectProfile(input.profile_id) };
    if (operation === "account.refresh") return this.#refreshAccountResources(input);
    throw new Error(`unsupported agent data operation: ${operation}`);
  }

  async #listSkills() {
    return (await this.#skillEntries()).map(({ directory: _directory, managed: _managed, content, ...item }) => ({
      ...item,
      size_bytes: Buffer.byteLength(content),
    }));
  }

  async #skillDirectory(name) {
    const base = slug(name) || "skill";
    let directoryName = base;
    const existing = new Set((await readdir(this.local.skills, { withFileTypes: true })).map((entry) => entry.name));
    while (existing.has(directoryName)) directoryName = `${base}-${crypto.randomUUID().slice(0, 8)}`;
    return resolve(this.local.skills, directoryName);
  }

  async #writeSkill(directory, metadata, content) {
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, "SKILL.md"), content, { mode: 0o644 });
    await atomicJson(resolve(directory, ".zidane.json"), metadata);
  }

  async #skillEntries() {
    await mkdir(this.local.skills, { recursive: true });
    return discoverSkills(this.local.skills);
  }

  async #createSkill(input) {
    await mkdir(this.local.skills, { recursive: true });
    const name = validName(input.name, "skill");
    const content = validContent(input.content);
    const directory = await this.#skillDirectory(name);
    const timestamp = Date.now();
    const metadata = { id: crypto.randomUUID(), name, source: { scope: "agent" }, created_at: timestamp, updated_at: timestamp };
    await this.#writeSkill(directory, metadata, content);
    return publicSkill({ ...metadata, content });
  }

  async #getSkill(skillId) {
    const entry = (await this.#skillEntries()).find((item) => item.skill_id === String(skillId ?? ""));
    if (!entry) throw new Error("skill not found");
    const { directory: _directory, managed: _managed, ...item } = entry;
    return item;
  }

  async #updateSkill(input) {
    const entry = (await this.#skillEntries()).find((item) => item.skill_id === String(input.skill_id ?? ""));
    if (!entry) throw new Error("skill not found");
    const name = validName(input.name, "skill");
    const content = validContent(input.content);
    const timestamp = Date.now();
    const metadata = {
      id: entry.skill_id,
      name,
      source: entry.source,
      created_at: entry.created_at,
      updated_at: timestamp,
    };
    await this.#writeSkill(entry.directory, metadata, content);
    return publicSkill({ ...metadata, content });
  }

  async #deleteSkill(skillId) {
    const entry = (await this.#skillEntries()).find((item) => item.skill_id === String(skillId ?? ""));
    if (!entry) return false;
    if (entry.managed) await rm(entry.directory, { recursive: true, force: true });
    else {
      await rm(resolve(entry.directory, "SKILL.md"), { force: true });
      await rm(resolve(entry.directory, ".zidane.json"), { force: true });
    }
    return true;
  }

  async #importSkills(rawItems) {
    const incoming = Array.isArray(rawItems) ? rawItems : [];
    if (!incoming.length || incoming.length > 100) throw new Error("select between 1 and 100 skills");
    await mkdir(this.local.skills, { recursive: true });
    const entries = await this.#skillEntries();
    const imported = [];
    for (const raw of incoming) {
      const sourceId = validId(raw.source_id, "account skill");
      const name = validName(raw.name, "skill");
      const content = validContent(raw.content);
      const existing = entries.find((item) => item.source?.scope === "account" && item.source.id === sourceId);
      const timestamp = Date.now();
      const metadata = {
        id: existing?.skill_id ?? crypto.randomUUID(),
        name,
        source: { scope: "account", id: sourceId },
        created_at: existing?.created_at ?? timestamp,
        updated_at: timestamp,
      };
      await this.#writeSkill(existing?.directory ?? (await this.#skillDirectory(name)), metadata, content);
      imported.push(publicSkill({ ...metadata, content }));
    }
    return imported;
  }

  async #refreshAccountSkills(incoming) {
    const allowed = new Map(incoming.map((raw) => [validId(raw.source_id, "account skill"), raw]));
    let updated = 0;
    let removed = 0;
    for (const entry of await this.#skillEntries()) {
      if (entry.source?.scope !== "account") continue;
      const raw = allowed.get(entry.source.id);
      if (!raw) {
        await rm(entry.directory, { recursive: true, force: true });
        removed += 1;
        continue;
      }
      await this.#writeSkill(
        entry.directory,
        {
          id: entry.skill_id,
          name: validName(raw.name, "skill"),
          source: entry.source,
          created_at: entry.created_at,
          updated_at: Date.now(),
        },
        validContent(raw.content),
      );
      updated += 1;
    }
    return { updated, removed };
  }

  async #loadConfigs() {
    await mkdir(this.configDirectory, { recursive: true });
    const items = [];
    for (const entry of await readdir(this.configDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const item = await readJson(resolve(this.configDirectory, entry.name), null);
      if (item && SAFE_ID.test(String(item.id ?? "")) && item.values && typeof item.values === "object") items.push(item);
    }
    if (!items.length) {
      const applied = await readJson(resolve(this.local.config, "applied.json"), null);
      if (applied?.values && Object.keys(applied.values).length) {
        const timestamp = Date.now();
        const migrated = {
          id: "legacy-applied",
          name: "Previously applied configuration",
          values: validValues(applied.values),
          source: { scope: "legacy", id: String(applied.revision ?? "") },
          created_at: timestamp,
          updated_at: timestamp,
        };
        await this.#saveConfig(migrated);
        items.push(migrated);
      }
    }
    return items.sort((left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id));
  }

  async #saveConfig(item) {
    if (!SAFE_ID.test(item.id)) throw new Error("invalid configuration id");
    await mkdir(this.configDirectory, { recursive: true });
    await atomicJson(resolve(this.configDirectory, `${item.id}.json`), item);
  }

  async #materializeConfigs(items) {
    const values = {};
    for (const item of items.sort((left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id))) {
      Object.assign(values, item.values);
    }
    await applyConfigValues(this.local, `agent-config-${crypto.randomUUID()}`, values);
  }

  async #createConfig(input) {
    const items = await this.#loadConfigs();
    const timestamp = Date.now();
    const item = {
      id: crypto.randomUUID(),
      name: validName(input.name, "configuration"),
      values: validValues(input.values),
      source: { scope: "agent" },
      created_at: timestamp,
      updated_at: timestamp,
    };
    await this.#saveConfig(item);
    items.push(item);
    await this.#materializeConfigs(items);
    return publicConfig(item);
  }

  async #getConfig(configIdValue) {
    const configId = validId(configIdValue, "configuration");
    const item = (await this.#loadConfigs()).find((candidate) => candidate.id === configId);
    if (!item) throw new Error("configuration not found");
    return publicConfig(item);
  }

  async #updateConfig(input) {
    const configId = validId(input.config_id, "configuration");
    const items = await this.#loadConfigs();
    const item = items.find((candidate) => candidate.id === configId);
    if (!item) throw new Error("configuration not found");
    item.name = validName(input.name, "configuration");
    item.values = validValues(input.values);
    item.updated_at = Date.now();
    await this.#saveConfig(item);
    await this.#materializeConfigs(items);
    return publicConfig(item);
  }

  async #deleteConfig(configIdValue) {
    const configId = validId(configIdValue, "configuration");
    const items = await this.#loadConfigs();
    const kept = items.filter((item) => item.id !== configId);
    if (kept.length === items.length) return false;
    await rm(resolve(this.configDirectory, `${configId}.json`), { force: true });
    await this.#materializeConfigs(kept);
    return true;
  }

  async #importConfigs(rawItems) {
    const incoming = Array.isArray(rawItems) ? rawItems : [];
    if (!incoming.length || incoming.length > 100) throw new Error("select between 1 and 100 configuration maps");
    const items = await this.#loadConfigs();
    const imported = [];
    for (const raw of incoming) {
      const sourceId = validId(raw.source_id, "account configuration");
      const existing = items.find((item) => item.source?.scope === "account" && item.source.id === sourceId);
      const timestamp = Date.now();
      const item = existing ?? {
        id: crypto.randomUUID(),
        source: { scope: "account", id: sourceId },
        created_at: timestamp,
      };
      item.name = validName(raw.name, "configuration");
      item.values = validValues(raw.values);
      item.updated_at = timestamp;
      if (!existing) items.push(item);
      await this.#saveConfig(item);
      imported.push(publicConfig(item));
    }
    await this.#materializeConfigs(items);
    return imported;
  }

  async #loadSecrets() {
    await mkdir(this.local.syncedSecrets, { recursive: true });
    await this.#migrateFlatSecrets();
    const stored = await readJson(this.secretMetadata, []);
    let items = Array.isArray(stored) ? stored : [];
    const storedCount = items.length;
    const directories = new Map();
    for (const entry of await readdir(this.local.syncedSecrets, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SAFE_KEY.test(entry.name)) continue;
      const directory = resolve(this.local.syncedSecrets, entry.name);
      await chmod(directory, 0o700);
      directories.set(entry.name, await secretKeys(directory));
    }
    items = items.filter((item) => SAFE_ID.test(String(item.id ?? "")) && SAFE_KEY.test(String(item.name ?? "")) && directories.has(item.name));
    const knownNames = new Set(items.map((item) => item.name));
    let changed = !Array.isArray(stored) || items.length !== storedCount;
    for (const name of directories.keys()) {
      if (knownNames.has(name)) continue;
      const details = await stat(resolve(this.local.syncedSecrets, name));
      items.push({
        id: `legacy-${createHash("sha256").update(name).digest("hex").slice(0, 16)}`,
        name,
        source: { scope: "legacy" },
        created_at: details.birthtimeMs || details.mtimeMs,
        updated_at: details.mtimeMs,
      });
      changed = true;
    }
    if (changed) await this.#saveSecretMetadata(items);
    return items
      .map((item) => ({ ...item, keys: directories.get(item.name) ?? [] }))
      .sort((left, right) => left.created_at - right.created_at || left.name.localeCompare(right.name));
  }

  /** A secret used to be one flat file; it is now a directory of key files. */
  async #migrateFlatSecrets() {
    for (const entry of await readdir(this.local.syncedSecrets, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.endsWith(".new") || !SAFE_KEY.test(entry.name)) continue;
      const flat = resolve(this.local.syncedSecrets, entry.name);
      const value = await readFile(flat, "utf8");
      await rm(flat, { force: true });
      await this.#writeSecretEntries(entry.name, { value });
    }
  }

  async #saveSecretMetadata(items) {
    await atomicJson(this.secretMetadata, items.map(({ keys: _keys, ...item }) => item), 0o600);
  }

  #secretDirectory(name) {
    const target = resolve(this.local.syncedSecrets, name);
    if (dirname(target) !== this.local.syncedSecrets) throw new Error("secret path escapes agent store");
    return target;
  }

  /** Replace every null with the value already stored under `name`. */
  async #resolveKeptValues(name, values) {
    const directory = this.#secretDirectory(name);
    const resolved = {};
    for (const [key, value] of Object.entries(values)) {
      if (value !== null) {
        resolved[key] = value;
        continue;
      }
      try {
        resolved[key] = await readFile(resolve(directory, key), "utf8");
      } catch {
        throw new Error(`there is no stored value to keep for ${key}`);
      }
    }
    return resolved;
  }

  /** Write every key and drop the ones this revision no longer carries. */
  async #writeSecretEntries(name, values) {
    const directory = this.#secretDirectory(name);
    await mkdir(directory, { recursive: true });
    await chmod(directory, 0o700);
    for (const key of await secretKeys(directory)) {
      if (!(key in values)) await rm(resolve(directory, key), { force: true });
    }
    for (const [key, value] of Object.entries(values)) {
      const target = resolve(directory, key);
      const pending = `${target}.new`;
      await writeFile(pending, value, { mode: 0o600 });
      await rename(pending, target);
      await chmod(target, 0o600);
    }
  }

  async #createSecret(input) {
    const items = await this.#loadSecrets();
    const name = validSecretName(input.name);
    if (items.some((item) => item.name === name)) throw new Error("an agent secret with this name already exists");
    const values = validSecretValues(input.values);
    const timestamp = Date.now();
    const item = { id: crypto.randomUUID(), name, source: { scope: "agent" }, created_at: timestamp, updated_at: timestamp };
    await this.#writeSecretEntries(name, values);
    items.push(item);
    await this.#saveSecretMetadata(items);
    return publicSecret({ ...item, keys: Object.keys(values).sort() });
  }

  async #updateSecret(input) {
    const secretId = validId(input.secret_id, "secret");
    const items = await this.#loadSecrets();
    const item = items.find((candidate) => candidate.id === secretId);
    if (!item) throw new Error("secret not found");
    const name = validSecretName(input.name);
    if (items.some((candidate) => candidate.id !== secretId && candidate.name === name)) throw new Error("an agent secret with this name already exists");
    const values = await this.#resolveKeptValues(
      item.name,
      validSecretValues(input.values, { allowKept: true }),
    );
    const oldName = item.name;
    await this.#writeSecretEntries(name, values);
    item.name = name;
    item.keys = Object.keys(values).sort();
    item.updated_at = Date.now();
    await this.#saveSecretMetadata(items);
    if (oldName !== name) await rm(this.#secretDirectory(oldName), { recursive: true, force: true });
    return publicSecret(item);
  }

  async #deleteSecret(secretIdValue) {
    const secretId = validId(secretIdValue, "secret");
    const items = await this.#loadSecrets();
    const item = items.find((candidate) => candidate.id === secretId);
    if (!item) return false;
    await rm(this.#secretDirectory(item.name), { recursive: true, force: true });
    await this.#saveSecretMetadata(items.filter((candidate) => candidate.id !== secretId));
    return true;
  }

  async #importSecrets(rawItems) {
    const incoming = Array.isArray(rawItems) ? rawItems : [];
    if (!incoming.length || incoming.length > 100) throw new Error("select between 1 and 100 secrets");
    const items = await this.#loadSecrets();
    const planned = items.map((item) => ({ ...item, source: { ...item.source } }));
    const changes = [];
    for (const raw of incoming) {
      const sourceId = validId(raw.source_id, "account secret");
      const name = validSecretName(raw.name);
      const existing = planned.find((item) => item.source?.scope === "account" && item.source.id === sourceId);
      const timestamp = Date.now();
      const item = existing ?? { id: crypto.randomUUID(), source: { scope: "account", id: sourceId }, created_at: timestamp };
      if (planned.some((candidate) => candidate.id !== item.id && candidate.name === name)) {
        throw new Error(`an agent secret named ${name} already exists`);
      }
      const oldName = existing?.name;
      item.name = name;
      item.updated_at = timestamp;
      if (!existing) planned.push(item);
      changes.push({ item, oldName, values: validSecretValues(raw.values) });
    }
    for (const change of changes) {
      await this.#writeSecretEntries(change.item.name, change.values);
      change.item.keys = Object.keys(change.values).sort();
    }
    await this.#saveSecretMetadata(planned);
    for (const change of changes) {
      if (change.oldName && change.oldName !== change.item.name) {
        await rm(this.#secretDirectory(change.oldName), { recursive: true, force: true });
      }
      change.values = {};
    }
    return changes.map((change) => publicSecret(change.item));
  }

  /** Re-apply the account resources this agent may still see, and drop the rest. */
  async #refreshAccountResources(input) {
    return {
      skills: await this.#refreshAccountSkills(Array.isArray(input.skills) ? input.skills : []),
      configs: await this.#refreshAccountConfigs(Array.isArray(input.configs) ? input.configs : []),
      secrets: await this.#refreshAccountSecrets(Array.isArray(input.secrets) ? input.secrets : []),
    };
  }

  async #refreshAccountConfigs(incoming) {
    const allowed = new Map(incoming.map((raw) => [validId(raw.source_id, "account configuration"), raw]));
    const kept = [];
    let updated = 0;
    let removed = 0;
    for (const item of await this.#loadConfigs()) {
      if (item.source?.scope !== "account") { kept.push(item); continue; }
      const raw = allowed.get(item.source.id);
      if (!raw) {
        await rm(resolve(this.configDirectory, `${item.id}.json`), { force: true });
        removed += 1;
        continue;
      }
      item.name = validName(raw.name, "configuration");
      item.values = validValues(raw.values);
      item.updated_at = Date.now();
      await this.#saveConfig(item);
      updated += 1;
      kept.push(item);
    }
    if (updated || removed) await this.#materializeConfigs(kept);
    return { updated, removed };
  }

  async #refreshAccountSecrets(incoming) {
    const allowed = new Map(incoming.map((raw) => [validId(raw.source_id, "account secret"), raw]));
    const items = await this.#loadSecrets();
    const kept = [];
    let updated = 0;
    let removed = 0;
    for (const item of items) {
      if (item.source?.scope !== "account") { kept.push(item); continue; }
      const raw = allowed.get(item.source.id);
      if (!raw) {
        await rm(this.#secretDirectory(item.name), { recursive: true, force: true });
        removed += 1;
        continue;
      }
      const name = validSecretName(raw.name);
      // A rename must not land on any other secret, including one not yet visited.
      if (items.some((candidate) => candidate.id !== item.id && candidate.name === name)) {
        throw new Error(`an agent secret named ${name} already exists`);
      }
      const values = validSecretValues(raw.values);
      const oldName = item.name;
      await this.#writeSecretEntries(name, values);
      if (oldName !== name) await rm(this.#secretDirectory(oldName), { recursive: true, force: true });
      item.name = name;
      item.keys = Object.keys(values).sort();
      item.updated_at = Date.now();
      updated += 1;
      kept.push(item);
    }
    await this.#saveSecretMetadata(kept);
    return { updated, removed };
  }


  // ------------------------------------------------------------ LLM profiles
  //
  // The agent owns these outright: the control plane relays CRUD and keeps no copy,
  // so a profile survives the server losing its database. A profile names one of the
  // agent's own secrets rather than carrying a key, so no credential crosses the relay.

  #profilePath(profileId) {
    const target = resolve(this.profileDirectory, `${profileId}.json`);
    if (dirname(target) !== this.profileDirectory) throw new Error("profile path escapes agent store");
    return target;
  }

  /** The selected profile's id. A pre-relay agent stored the whole profile here. */
  async #defaultProfileId() {
    try {
      const stored = JSON.parse(await readFile(this.defaultProfileFile, "utf8"));
      return String(stored.profile_id ?? "");
    } catch { return ""; }
  }

  async #loadProfiles() {
    await mkdir(this.profileDirectory, { recursive: true });
    const items = [];
    for (const entry of await readdir(this.profileDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const profile = JSON.parse(await readFile(resolve(this.profileDirectory, entry.name), "utf8"));
        if (SAFE_ID.test(String(profile.profile_id ?? ""))) items.push(profile);
      } catch { /* a half-written or hand-edited file is not fatal */ }
    }
    return items.sort((left, right) => String(left.name).localeCompare(String(right.name)));
  }

  async #listProfiles() {
    const defaultId = await this.#defaultProfileId();
    return (await this.#loadProfiles()).map((profile) => publicProfile(profile, defaultId));
  }

  /** Validate a write and resolve which agent secret key it will read at run time. */
  async #cleanProfile(input, profileId) {
    const name = String(input.name ?? "").trim();
    if (!name || name.length > 120) throw new Error("profile name must contain 1 to 120 characters");
    const existing = await this.#loadProfiles();
    if (existing.some((item) => item.name === name && item.profile_id !== profileId)) {
      throw new Error("an LLM profile with this name already exists");
    }
    const provider = String(input.provider ?? "");
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(provider)) throw new Error("invalid LLM provider");
    const model = String(input.model ?? "").trim();
    if (!model || model.length > 240) throw new Error("invalid LLM model");
    const baseUrl = input.base_url ? String(input.base_url) : null;
    const api = input.api ? String(input.api) : null;
    if (Boolean(baseUrl) !== Boolean(api)) throw new Error("base_url and api must be set together");
    if (api && !LLM_APIS.has(api)) throw new Error(`unsupported LLM API: ${api}`);
    if (baseUrl && !/^https?:\/\/[^\s]+$/.test(baseUrl)) throw new Error("base_url must be an http(s) URL");
    const thinkingLevel = String(input.thinking_level ?? "medium");
    if (!THINKING_LEVELS.has(thinkingLevel)) throw new Error(`unsupported thinking level: ${thinkingLevel}`);
    const tools = Array.isArray(input.tools) ? input.tools.slice(0, 32).map((tool) => String(tool)) : [];

    let secretName = null;
    let secretKey = null;
    if (input.secret_name) {
      secretName = validSecretName(input.secret_name);
      const secret = (await this.#loadSecrets()).find((item) => item.name === secretName);
      if (!secret) throw new Error(`this agent has no secret named ${secretName}`);
      if (input.secret_key) {
        secretKey = String(input.secret_key);
        if (!secret.keys.includes(secretKey)) throw new Error(`secret ${secretName} has no key named ${secretKey}`);
      } else if (secret.keys.length === 1) {
        secretKey = secret.keys[0];
      } else {
        throw new Error(`secret ${secretName} holds several keys; choose the one to use`);
      }
    } else if (input.secret_key) {
      throw new Error("choose a secret before a key");
    }
    return { name, provider, model, secret_name: secretName, secret_key: secretKey, base_url: baseUrl, api, thinking_level: thinkingLevel, tools };
  }

  /** A custom endpoint has to reach Pi's own model store to be selectable. */
  async #registerCustomModel(profile) {
    if (!profile.base_url || !profile.api) return;
    const modelsPath = resolve(this.local.config, "models.json");
    let models;
    try { models = JSON.parse(await readFile(modelsPath, "utf8")); } catch { models = { providers: {} }; }
    models.providers ??= {};
    const configured = models.providers[profile.provider] ?? {};
    const entries = Array.isArray(configured.models) ? configured.models : [];
    if (!entries.some((entry) => entry.id === profile.model)) entries.push({ id: profile.model });
    models.providers[profile.provider] = { ...configured, baseUrl: profile.base_url, api: profile.api, models: entries };
    await atomicJson(modelsPath, models, 0o600);
  }

  async #writeProfile(profile) {
    await mkdir(this.profileDirectory, { recursive: true });
    await atomicJson(this.#profilePath(profile.profile_id), profile, 0o600);
    await this.#registerCustomModel(profile);
  }

  async #createProfile(input) {
    const profileId = crypto.randomUUID();
    const clean = await this.#cleanProfile(input, profileId);
    const timestamp = Date.now();
    const profile = { profile_id: profileId, ...clean, created_at: timestamp, updated_at: timestamp };
    await this.#writeProfile(profile);
    // The first profile becomes the selected one; nothing else could be.
    if (input.set_default || !(await this.#defaultProfileId())) return this.#selectProfile(profileId);
    return publicProfile(profile, await this.#defaultProfileId());
  }

  async #updateProfile(input) {
    const profileId = validId(input.profile_id, "LLM profile");
    const current = (await this.#loadProfiles()).find((item) => item.profile_id === profileId);
    if (!current) throw new Error("LLM profile not found");
    const clean = await this.#cleanProfile(input, profileId);
    const profile = { ...current, ...clean, updated_at: Date.now() };
    await this.#writeProfile(profile);
    if (input.set_default) return this.#selectProfile(profileId);
    return publicProfile(profile, await this.#defaultProfileId());
  }

  async #deleteProfile(profileIdValue) {
    const profileId = validId(profileIdValue, "LLM profile");
    if (!(await this.#loadProfiles()).some((item) => item.profile_id === profileId)) return false;
    await rm(this.#profilePath(profileId), { force: true });
    // Deleting the selected profile leaves the agent with none, rather than silently
    // promoting one it was never told to use.
    if ((await this.#defaultProfileId()) === profileId) await rm(this.defaultProfileFile, { force: true });
    return true;
  }

  async #selectProfile(profileIdValue) {
    const profileId = validId(profileIdValue, "LLM profile");
    const profile = (await this.#loadProfiles()).find((item) => item.profile_id === profileId);
    if (!profile) throw new Error("LLM profile not found");
    await atomicJson(this.defaultProfileFile, { profile_id: profileId }, 0o600);
    return publicProfile(profile, profileId);
  }
}

async function discoverSkills(root) {
  const found = [];
  async function walk(directory, depth) {
    if (depth > 8) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const child = resolve(directory, entry.name);
      try {
        const skillPath = resolve(child, "SKILL.md");
        const content = await readFile(skillPath, "utf8");
        const details = await stat(skillPath);
        const metadata = await readJson(resolve(child, ".zidane.json"), null);
        const relativePath = relative(root, child).split("\\").join("/");
        const managed = Boolean(metadata && SAFE_ID.test(String(metadata.id ?? "")));
        found.push({
          skill_id: managed ? metadata.id : `manual-${createHash("sha256").update(relativePath).digest("hex").slice(0, 16)}`,
          name: validStoredName(metadata?.name) ?? inferredSkillName(content, entry.name),
          source: managed && metadata.source?.scope === "account" && SAFE_ID.test(String(metadata.source.id ?? ""))
            ? { scope: "account", id: String(metadata.source.id) }
            : { scope: managed ? "agent" : "manual" },
          content,
          created_at: Number(metadata?.created_at) || details.birthtimeMs || details.mtimeMs,
          updated_at: Number(metadata?.updated_at) || details.mtimeMs,
          directory: child,
          managed,
        });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await walk(child, depth + 1);
    }
  }
  await walk(root, 0);
  return found.sort((left, right) => left.name.localeCompare(right.name));
}

function inferredSkillName(content, fallback) {
  const frontmatter = /^---\s*\n([\s\S]*?)\n---/.exec(content)?.[1] ?? "";
  const declared = /^name:\s*["']?(.+?)["']?\s*$/m.exec(frontmatter)?.[1]?.trim();
  const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
  return validStoredName(declared) ?? validStoredName(heading) ?? fallback;
}

function validStoredName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  return name && name.length <= 120 ? name : null;
}

function validName(value, label) {
  const name = String(value ?? "").trim();
  if (!name || name.length > 120) throw new Error(`${label} name must contain 1 to 120 characters`);
  return name;
}

function validId(value, label) {
  const id = String(value ?? "");
  if (!SAFE_ID.test(id)) throw new Error(`invalid ${label} id`);
  return id;
}

function validContent(value) {
  const content = String(value ?? "");
  if (!content.trim() || Buffer.byteLength(content) > MAX_VALUE_BYTES) throw new Error("skill content must contain 1 to 1000000 bytes");
  return content;
}

function validValues(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("configuration values must be an object");
  const entries = Object.entries(value);
  if (entries.length > 500) throw new Error("configuration cannot contain more than 500 entries");
  const clean = {};
  let size = 0;
  for (const [key, item] of entries) {
    if (!SAFE_KEY.test(key)) throw new Error(`unsafe configuration key: ${key}`);
    const text = String(item);
    size += Buffer.byteLength(key) + Buffer.byteLength(text);
    if (size > MAX_VALUE_BYTES) throw new Error("configuration exceeds 1000000 bytes");
    clean[key] = text;
  }
  return clean;
}

function validSecretName(value) {
  const name = String(value ?? "").trim();
  if (!SAFE_KEY.test(name) || name.length > 120) throw new Error("secret name must be a safe 1 to 120 character key");
  return name;
}

/** With `allowKept`, a null value survives as null and means "keep what is stored". */
function validSecretValues(value, { allowKept = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("secret values must be a key/value map");
  const entries = Object.entries(value);
  if (!entries.length) throw new Error("a secret needs at least one key");
  if (entries.length > 500) throw new Error("a secret cannot hold more than 500 keys");
  const clean = {};
  let size = 0;
  for (const [key, item] of entries) {
    if (!SAFE_KEY.test(key) || key.length > 120) throw new Error(`unsafe secret key: ${key}`);
    if (allowKept && item === null) {
      clean[key] = null;
      continue;
    }
    const secret = String(item ?? "");
    size += Buffer.byteLength(secret);
    if (!secret || size > MAX_VALUE_BYTES) throw new Error("secret values must contain 1 to 1000000 bytes");
    clean[key] = secret;
  }
  return clean;
}

async function secretKeys(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && !entry.name.endsWith(".new") && SAFE_KEY.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function publicSkill(item) {
  return {
    skill_id: item.id,
    name: item.name,
    content: item.content,
    source: item.source ?? { scope: "agent" },
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

function publicConfig(item) {
  return {
    config_id: item.id,
    name: item.name,
    values: item.values,
    source: item.source ?? { scope: "agent" },
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

function publicConfigSummary(item) {
  const { values: _values, ...summary } = publicConfig(item);
  return { ...summary, keys: Object.keys(item.values).sort(), entry_count: Object.keys(item.values).length };
}

/** Never carries a credential: a profile only ever names the secret to read. */
function publicProfile(profile, defaultId) {
  return {
    profile_id: profile.profile_id,
    name: profile.name,
    provider: profile.provider,
    model: profile.model,
    secret_name: profile.secret_name ?? null,
    secret_key: profile.secret_key ?? null,
    base_url: profile.base_url ?? null,
    api: profile.api ?? null,
    thinking_level: profile.thinking_level ?? "medium",
    tools: profile.tools ?? [],
    is_default: profile.profile_id === defaultId,
    created_at: profile.created_at,
    updated_at: profile.updated_at,
  };
}

function publicSecret(item) {
  const keys = item.keys ?? [];
  return {
    secret_id: item.id,
    name: item.name,
    keys,
    entry_count: keys.length,
    source: item.source ?? { scope: "agent" },
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function atomicJson(target, value, mode = 0o644) {
  await mkdir(dirname(target), { recursive: true });
  const pending = `${target}.new`;
  await writeFile(pending, JSON.stringify(value, null, 2), { mode });
  await rename(pending, target);
  await chmod(target, mode);
}
