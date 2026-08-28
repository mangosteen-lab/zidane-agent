import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { applyConfigValues } from "./config.mjs";
import { readEnvFile, writeEnvFile, SAFE_ENV_KEY } from "./dotenv.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const LLM_APIS = new Set(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const MAX_VALUE_BYTES = 1_000_000;

/**
 * A skill's identity, which travels in the file.
 *
 * An account row, an agent's copy, a file in a git branch, and something pasted into the
 * editor are all the same skill when they carry the same `id:` in their frontmatter —
 * the way a knowledge article already works. Reconcilers can then ask "is this the same
 * one?" without matching on a name that someone is going to rename, and `.zidane.json`
 * holds only what a file cannot (its source, its timestamps) and is rebuildable from it.
 *
 * Pi reads `name`, `description`, and `disable-model-invocation` from this block and
 * ignores everything else, so an `id` line changes nothing about how a skill loads.
 */
export function skillIdentity(content) {
  const block = FRONTMATTER.exec(String(content ?? ""));
  if (!block) return "";
  for (const line of block[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1 || line.slice(0, separator).trim() !== "id") continue;
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    return SAFE_ID.test(value) ? value : "";
  }
  return "";
}

/** The same content, declaring `id`. Whatever it declared before does not survive. */
export function withSkillIdentity(content, id) {
  const text = String(content ?? "");
  const block = FRONTMATTER.exec(text);
  // A file with no frontmatter declares no description either, so Pi already skips it;
  // a block holding just the id leaves it no worse off and keeps the id with the content.
  if (!block) return `---\nid: ${id}\n---\n${text}`;
  const lines = block[1].split(/\r?\n/);
  const at = lines.findIndex((line) => {
    const separator = line.indexOf(":");
    return separator > 0 && line.slice(0, separator).trim() === "id";
  });
  if (at >= 0) lines[at] = `id: ${id}`;
  else lines.unshift(`id: ${id}`);
  return `---\n${lines.join("\n")}\n---\n${text.slice(block[0].length)}`;
}

/** Agent-owned CRUD store for Pi skills, config maps, secrets, and LLM profiles. */
export class AgentDataStore {
  #pending = Promise.resolve();

  constructor(local, knowledge, cron) {
    this.local = local;
    this.knowledge = knowledge;
    // Present only where a scheduler is running; the REST relay reports the operation as
    // unsupported rather than pretending a task was stored on an agent that cannot run it.
    this.cron = cron;
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
    if (operation === "skill.adopt") return { item: await this.#adoptSkill(input) };
    if (operation === "config.list") return { items: (await this.#loadConfigs()).map((item) => publicConfig(item)) };
    if (operation === "config.get") return { item: await this.#getConfig(input.config_id) };
    if (operation === "config.create") return { item: await this.#createConfig(input) };
    if (operation === "config.update") return { item: await this.#updateConfig(input) };
    if (operation === "config.delete") return { deleted: await this.#deleteConfig(input.config_id) };
    if (operation === "llm.list") return { items: await this.#listProfiles() };
    if (operation === "llm.create") return { item: await this.#createProfile(input) };
    if (operation === "llm.update") return { item: await this.#updateProfile(input) };
    if (operation === "llm.delete") return { deleted: await this.#deleteProfile(input.profile_id) };
    if (operation === "llm.select") return { item: await this.#selectProfile(input.profile_id) };
    if (operation === "cron.list") return this.#cron().list();
    if (operation === "cron.create") return { item: await this.#cron().store.create(input) };
    if (operation === "cron.update") return { item: await this.#cron().store.update(input) };
    if (operation === "cron.delete") return { deleted: await this.#cron().store.delete(input.task_id) };
    if (operation === "cron.run") return this.#cron().runNow(input.task_id);
    if (operation === "cron.progress") return this.#cron().progress(input.task_id);
    if (operation === "account.refresh") return this.#refreshAccountResources(input);
    throw new Error(`unsupported agent data operation: ${operation}`);
  }

  #cron() {
    if (!this.cron) throw new Error("scheduled tasks are not available on this agent");
    return this.cron;
  }

  async #listSkills() {
    return (await this.#skillEntries()).map(({ directory: _directory, managed: _managed, identity: _identity, content, ...item }) => ({
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
    // A skill arriving with an id keeps it, which is what makes a paste, a restored
    // export, and a promoted copy the same skill. One already in use here does not
    // transfer: an id is asserted by whoever mints it, never by pasted content.
    const declared = skillIdentity(content);
    const taken = new Set((await this.#skillEntries()).map((entry) => entry.skill_id));
    const id = declared && !taken.has(declared) ? declared : crypto.randomUUID();
    const directory = await this.#skillDirectory(name);
    const timestamp = Date.now();
    const metadata = { id, name, source: { scope: "agent" }, created_at: timestamp, updated_at: timestamp };
    const body = withSkillIdentity(content, id);
    await this.#writeSkill(directory, metadata, body);
    return publicSkill({ ...metadata, content: body });
  }

  async #getSkill(skillId) {
    const entry = (await this.#skillEntries()).find((item) => item.skill_id === String(skillId ?? ""));
    if (!entry) throw new Error("skill not found");
    const { directory: _directory, managed: _managed, identity: _identity, ...item } = entry;
    return item;
  }

  async #updateSkill(input) {
    const entry = (await this.#skillEntries()).find((item) => item.skill_id === String(input.skill_id ?? ""));
    if (!entry) throw new Error("skill not found");
    const name = validName(input.name, "skill");
    const content = validContent(input.content);
    const timestamp = Date.now();
    // The record's own id is written back over whatever the submitted content declares,
    // so editing a skill can neither drop its identity nor rebind it to another one. A
    // hand-placed file that has never had one is given one here, on its first write.
    const id = entry.identity || crypto.randomUUID();
    const metadata = {
      id,
      name,
      source: entry.source,
      created_at: entry.created_at,
      updated_at: timestamp,
    };
    const body = withSkillIdentity(content, id);
    await this.#writeSkill(entry.directory, metadata, body);
    return publicSkill({ ...metadata, content: body });
  }

  /**
   * Bind a local skill to the account row it was just published to.
   *
   * The account row's id becomes this copy's id, in the sidecar and in the file, so the
   * next sync updates this directory instead of importing a second copy of what is
   * already here. A hand-placed skill becomes a managed one — publishing it is the
   * explicit act that makes it the account's, and from then on a sync governs it.
   */
  async #adoptSkill(input) {
    const entry = (await this.#skillEntries()).find((item) => item.skill_id === String(input.skill_id ?? ""));
    if (!entry) throw new Error("skill not found");
    const sourceId = validId(input.source_id, "account skill");
    const clash = (await this.#skillEntries()).find((item) => item.skill_id === sourceId && item.directory !== entry.directory);
    if (clash) throw new Error(`another skill here already has the id ${sourceId}`);
    const content = withSkillIdentity(entry.content, sourceId);
    const metadata = {
      id: sourceId,
      name: entry.name,
      source: { scope: "account", id: sourceId },
      created_at: entry.created_at,
      updated_at: Date.now(),
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

  

  async #refreshAccountSkills(incoming) {
    const allowed = new Map(incoming.map((raw) => [validId(raw.source_id, "account skill"), raw]));
    let created = 0;
    let updated = 0;
    let removed = 0;
    await mkdir(this.local.skills, { recursive: true });
    const entries = await this.#skillEntries();

    // What the agent already holds for each account skill. A copy imported earlier says
    // so in its sidecar; one that arrived another way — restored from an export, or
    // promoted to the account from here — says so in the file itself. Matching on both
    // is what stops a sync growing a second copy beside the one already on disk. A
    // hand-placed skill is nobody's copy and is never touched.
    const held = new Map();
    for (const entry of entries) {
      if (entry.source?.scope === "manual") continue;
      const key = entry.source?.scope === "account" ? entry.source.id : entry.identity;
      if (key && !held.has(key)) held.set(key, entry);
    }

    // A copy whose source is no longer shared with this agent goes, which is what makes
    // revoking visibility take the skill off the disk.
    for (const entry of entries) {
      if (entry.source?.scope !== "account" || allowed.has(entry.source.id)) continue;
      await rm(entry.directory, { recursive: true, force: true });
      held.delete(entry.source.id);
      removed += 1;
    }

    for (const [sourceId, raw] of allowed) {
      const entry = held.get(sourceId);
      const name = validName(raw.name, "skill");
      const timestamp = Date.now();
      await this.#writeSkill(
        entry ? entry.directory : await this.#skillDirectory(name),
        {
          // The account row's id is the skill's id, here and in the file, so the two
          // levels never need a mapping to agree on what is the same skill.
          id: sourceId,
          name,
          source: { scope: "account", id: sourceId },
          created_at: entry ? entry.created_at : timestamp,
          updated_at: timestamp,
        },
        withSkillIdentity(validContent(raw.content), sourceId),
      );
      if (entry) updated += 1;
      else created += 1;
    }
    return { created, updated, removed };
  }

  /** Config maps used to live under `config/agent-config-maps/`. */
  // ------------------------------------------------------------- config maps
  //
  // One JSON record per map, `config-maps/<name>.json`. A record carries its ordinary
  // values inline and only the *names* of its secret values; the values themselves live
  // in the environment, seeded from `config-maps/.env`, and never enter the record.

  #configPath(name) {
    const target = resolve(this.local.configMaps, `${validConfigName(name)}.json`);
    if (dirname(target) !== this.local.configMaps) throw new Error("config map path escapes the store");
    return target;
  }

  async #loadConfigs() {
    await mkdir(this.local.configMaps, { recursive: true });
    const items = [];
    for (const entry of await readdir(this.local.configMaps, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const name = entry.name.slice(0, -".json".length);
      if (!SAFE_CONFIG_NAME.test(name)) continue;
      const record = await readJson(resolve(this.local.configMaps, entry.name), null);
      if (record) items.push(storedConfig(name, record));
    }
    return items.sort((left, right) => left.created_at - right.created_at || left.name.localeCompare(right.name));
  }

  async #findConfig(name) {
    const wanted = validConfigName(name);
    return (await this.#loadConfigs()).find((item) => item.name === wanted);
  }

  /** The merged effective configuration, in creation order. */
  async #applyConfigs() {
    const items = await this.#loadConfigs();
    const values = {};
    for (const item of items) Object.assign(values, item.normal_values);
    await applyConfigValues(this.local, `agent-config-${crypto.randomUUID()}`, values);
    return items;
  }

  /** Write any supplied secret values into `.env`; a null keeps what is stored. */
  async #applySecretEntries(entries) {
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return;
    const stored = await readEnvFile(this.local);
    let changed = false;
    for (const [key, value] of Object.entries(entries)) {
      if (!SAFE_ENV_KEY.test(key)) throw new Error(`unsafe secret value name: ${key}`);
      if (key.startsWith("ZIDANE_") || key.startsWith("AI_AGENT_")) throw new Error(`reserved secret value name: ${key}`);
      if (value === null) continue;
      stored[key] = String(value);
      process.env[key] = String(value);
      changed = true;
    }
    if (changed) await writeEnvFile(this.local, stored);
  }

  #configRecord(existing, input) {
    const timestamp = Date.now();
    return {
      title: typeof input.title === "string" && input.title.trim() ? input.title.trim() : existing?.title ?? validConfigName(input.name),
      description: typeof input.description === "string" ? input.description.slice(0, 2_000) : existing?.description ?? "",
      normal_values: validValues(input.normal_values ?? {}),
      secret_values: validSecretNames(input.secret_values, input.secret_entries),
      sync: input.sync ?? existing?.sync ?? false,
      source_id: input.source_id ?? existing?.source_id ?? null,
      created_at: existing?.created_at ?? timestamp,
      updated_at: timestamp,
    };
  }

  async #writeConfig(name, record) {
    await mkdir(this.local.configMaps, { recursive: true });
    await atomicJson(this.#configPath(name), record, 0o600);
  }

  async #createConfig(input) {
    const name = validConfigName(input.name);
    if (await this.#findConfig(name)) throw new Error("a config map with this name already exists");
    await this.#applySecretEntries(input.secret_entries);
    await this.#writeConfig(name, this.#configRecord(null, input));
    await this.#applyConfigs();
    return publicConfig(await this.#findConfig(name));
  }

  async #getConfig(nameValue) {
    const item = await this.#findConfig(nameValue);
    if (!item) throw new Error("configuration not found");
    return publicConfig(item, { includeValues: true });
  }

  async #updateConfig(input) {
    const current = await this.#findConfig(input.config_id);
    if (!current) throw new Error("configuration not found");
    const name = validConfigName(input.name);
    if (name !== current.name && await this.#findConfig(name)) {
      throw new Error("a config map with this name already exists");
    }
    await this.#applySecretEntries(input.secret_entries);
    await this.#writeConfig(name, this.#configRecord(current, input));
    if (name !== current.name) await rm(this.#configPath(current.name), { force: true });
    await this.#applyConfigs();
    return publicConfig(await this.#findConfig(name));
  }

  async #deleteConfig(nameValue) {
    const item = await this.#findConfig(nameValue);
    if (!item) return false;
    await rm(this.#configPath(item.name), { force: true });
    await this.#applyConfigs();
    return true;
  }

  

  async #refreshAccountResources(input) {
    return {
      skills: await this.#refreshAccountSkills(Array.isArray(input.skills) ? input.skills : []),
      configs: await this.#refreshAccountConfigs(Array.isArray(input.configs) ? input.configs : []),
      // Knowledge is replaced wholesale rather than reconciled: an article is only
      // ever a copy of what the account shares, never edited here.
      knowledge: this.knowledge
        ? await this.knowledge.apply(Array.isArray(input.knowledge) ? input.knowledge : [])
        : { count: 0 },
    };
  }

  async #refreshAccountConfigs(incoming) {
    const allowed = new Map(incoming.map((raw) => [validId(raw.source_id, "account configuration"), raw]));
    const seen = new Set();
    let created = 0;
    let updated = 0;
    let removed = 0;
    for (const item of await this.#loadConfigs()) {
      // Only synced copies are ours to touch; a hand-made map is left alone.
      if (!item.sync || !item.source_id) continue;
      const raw = allowed.get(item.source_id);
      if (!raw) {
        await rm(this.#configPath(item.name), { force: true });
        removed += 1;
        continue;
      }
      seen.add(item.source_id);
      const name = validConfigName(raw.name);
      const clash = await this.#findConfig(name);
      if (clash && clash.source_id !== item.source_id) throw new Error(`a config map named ${name} already exists`);
      await this.#applySecretEntries(raw.secret_entries);
      await this.#writeConfig(name, this.#configRecord(item, { ...raw, name, sync: true, source_id: item.source_id }));
      if (item.name !== name) await rm(this.#configPath(item.name), { force: true });
      updated += 1;
    }
    for (const [sourceId, raw] of allowed) {
      if (seen.has(sourceId)) continue;
      const name = validConfigName(raw.name);
      const clash = await this.#findConfig(name);
      if (clash && clash.source_id !== sourceId) throw new Error(`a config map named ${name} already exists`);
      await this.#applySecretEntries(raw.secret_entries);
      await this.#writeConfig(name, this.#configRecord(clash, { ...raw, name, sync: true, source_id: sourceId }));
      created += 1;
    }
    if (created || updated || removed) await this.#applyConfigs();
    return { created, updated, removed };
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

    let secretValue = null;
    if (input.secret_value) {
      secretValue = String(input.secret_value);
      if (!SAFE_ENV_KEY.test(secretValue)) throw new Error(`unsafe secret value name: ${secretValue}`);
      // Declared by some config map, or supplied straight through the environment.
      const declared = (await this.#loadConfigs()).some((item) => item.secret_values.includes(secretValue));
      if (!declared && process.env[secretValue] === undefined) {
        throw new Error(`no config map declares ${secretValue}, and it is not in the environment`);
      }
    }
    return { name, provider, model, secret_value: secretValue, base_url: baseUrl, api, thinking_level: thinkingLevel, tools };
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

export async function discoverSkills(root) {
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
        // The file is the record: an id in the frontmatter outranks the sidecar, so a
        // skill keeps its identity through a copy, an export, or a restore that leaves
        // `.zidane.json` behind. A file that has never carried one falls back to the
        // sidecar, and a hand-placed skill to a name derived from where it sits.
        const identity = skillIdentity(content) || (managed ? String(metadata.id) : "");
        found.push({
          identity,
          skill_id: identity || `manual-${createHash("sha256").update(relativePath).digest("hex").slice(0, 16)}`,
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

const SAFE_CONFIG_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,119}$/;

function validConfigName(value) {
  const name = String(value ?? "").trim();
  if (!SAFE_CONFIG_NAME.test(name)) throw new Error("config map name must be a safe 1 to 120 character key");
  return name;
}

/** The declared secret value names, including any the caller supplied a value for. */
function validSecretNames(declared, entries) {
  const names = new Set();
  for (const key of Array.isArray(declared) ? declared : []) {
    const name = String(key);
    if (!SAFE_ENV_KEY.test(name)) throw new Error(`unsafe secret value name: ${name}`);
    if (name.startsWith("ZIDANE_") || name.startsWith("AI_AGENT_")) throw new Error(`reserved secret value name: ${name}`);
    names.add(name);
  }
  for (const key of Object.keys(entries ?? {})) {
    if (!SAFE_ENV_KEY.test(key)) throw new Error(`unsafe secret value name: ${key}`);
    names.add(key);
  }
  if (names.size > 500) throw new Error("a config map cannot declare more than 500 secret values");
  return [...names].sort();
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

/** Normalise one stored record; unknown or malformed fields read as empty. */
function storedConfig(name, record) {
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
    sync: record.sync === true,
    source_id: typeof record.source_id === "string" && record.source_id ? record.source_id : null,
    created_at: Number(record.created_at) || 0,
    updated_at: Number(record.updated_at) || 0,
  };
}

/**
 * A config map as the control plane sees it.
 *
 * `secret_values` reports each declared name and whether a value is actually resolvable
 * right now — never the value itself.
 */
function publicConfig(item, { includeValues = false } = {}) {
  return {
    config_id: item.name,
    name: item.name,
    title: item.title,
    description: item.description,
    ...(includeValues ? { normal_values: item.normal_values } : {}),
    normal_keys: Object.keys(item.normal_values).sort(),
    secret_values: item.secret_values.map((key) => ({ key, resolved: process.env[key] !== undefined && process.env[key] !== "" })),
    entry_count: Object.keys(item.normal_values).length + item.secret_values.length,
    sync: item.sync,
    source_id: item.source_id,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

/** Never carries a credential: a profile only ever names the secret to read. */
function publicProfile(profile, defaultId) {
  return {
    profile_id: profile.profile_id,
    name: profile.name,
    provider: profile.provider,
    model: profile.model,
    secret_value: profile.secret_value ?? null,
    base_url: profile.base_url ?? null,
    api: profile.api ?? null,
    thinking_level: profile.thinking_level ?? "medium",
    tools: profile.tools ?? [],
    is_default: profile.profile_id === defaultId,
    created_at: profile.created_at,
    updated_at: profile.updated_at,
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
