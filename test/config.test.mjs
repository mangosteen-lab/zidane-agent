import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { applyAgentInfo, applyState, initialise, permissionsSufficient, readSecretValue, readSessionToken, resolveLlmProfile, writeSessionToken } from "../src/config.mjs";
import { AgentDataStore } from "../src/agent-data.mjs";

test("LLM profiles and rotating sessions persist without embedding credentials", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zidane-config-test-"));
  try {
    const config = { name: "test", version: "1", description: "test", capacity: 2, workingDirectory: root };
    const local = await initialise(config);
    await applyAgentInfo(local, config, { name: "managed-agent", description: "Managed from Zidane", capacity: 4 });
    assert.deepEqual(
      JSON.parse(await readFile(local.agent, "utf8")),
      { name: "managed-agent", version: "1", description: "Managed from Zidane", capacity: 4 },
    );
    const restarted = { name: "environment-name", version: "1", description: "environment description", capacity: 1, workingDirectory: root };
    await initialise(restarted);
    assert.equal(restarted.name, "managed-agent");
    assert.equal(restarted.description, "Managed from Zidane");
    assert.equal(restarted.capacity, 4);
    await writeSessionToken(local, "rotating-session");
    assert.equal(await readSessionToken(local), "rotating-session");
    assert.equal((await stat(local.token)).mode & 0o777, 0o600);

    // LLM profiles are agent-owned: created locally, and naming an agent secret
    // rather than carrying a credential of their own.
    const store = new AgentDataStore(local);
    await store.handle("config.create", {
      name: "local_model",
      title: "Local model",
      normal_values: {},
      secret_entries: { LOCAL_MODEL_KEY: "model-secret" },
    });
    const stored = (await store.handle("llm.create", {
      name: "Local model",
      provider: "local-openai",
      model: "coder-model",
      secret_value: "LOCAL_MODEL_KEY",
      base_url: "http://127.0.0.1:11434/v1",
      api: "openai-completions",
      thinking_level: "high",
    })).item;
    assert.equal(stored.secret_value, "LOCAL_MODEL_KEY");
    // The first profile is selected automatically; nothing else could be.
    assert.equal(stored.is_default, true);
    assert.equal((await store.handle("llm.list")).items.length, 1);

    const profileFile = await readFile(resolve(local.config, "llm-profiles", `${stored.profile_id}.json`), "utf8");
    const pointerFile = await readFile(resolve(local.config, "default-llm-profile.json"), "utf8");
    const modelsFile = await readFile(resolve(local.config, "models.json"), "utf8");
    assert.doesNotMatch(profileFile, /model-secret/);
    assert.doesNotMatch(pointerFile, /model-secret/);
    assert.doesNotMatch(modelsFile, /model-secret/);
    assert.equal(JSON.parse(modelsFile).providers["local-openai"].models[0].id, "coder-model");

    // What the runtime resolves for a prompt: the profile by id, the value by name.
    const resolved = await resolveLlmProfile(local, "");
    assert.equal(resolved.provider, "local-openai");
    assert.equal(resolved.model, "coder-model");
    assert.equal(readSecretValue(resolved.secret_value), "model-secret");
    assert.deepEqual(await resolveLlmProfile(local, "no-such-profile-id").catch(() => "rejected"), "rejected");

    await assert.rejects(
      store.handle("llm.create", { name: "Missing secret", provider: "local-openai", model: "coder-model", secret_value: "ABSENT_KEY" }),
      /no config map declares ABSENT_KEY/,
    );
    await assert.rejects(
      store.handle("llm.create", { name: "Half endpoint", provider: "local-openai", model: "coder-model", base_url: "http://x/v1" }),
      /base_url and api must be set together/,
    );
    // Deleting the selected profile leaves the agent with no default at all.
    assert.equal((await store.handle("llm.delete", { profile_id: stored.profile_id })).deleted, true);
    assert.deepEqual(await resolveLlmProfile(local, ""), {});

    const runtimeValues = {
      ZIDANE_TEST_RUNTIME_VALUE: "blocked",
      AGENT_TEST_SETTING: "enabled",
      "setting.with.dots": "stored-only",
    };
    await applyState(local, "revision-1", runtimeValues, { TOOL_PASSWORD: "tool-secret", TOOL_USER: "tool-user" });
    assert.equal(process.env.AGENT_TEST_SETTING, "enabled");
    assert.notEqual(process.env.ZIDANE_TEST_RUNTIME_VALUE, "blocked");
    assert.equal(await readSessionToken(local), "rotating-session");
    assert.equal(await readSessionToken(local), "rotating-session");
    assert.equal(readSecretValue("TOOL_PASSWORD"), "tool-secret");
    assert.equal(readSecretValue("TOOL_USER"), "tool-user");
    delete process.env.AGENT_TEST_SETTING;
    await initialise({ name: "test", version: "1", description: "test", workingDirectory: root });
    assert.equal(process.env.AGENT_TEST_SETTING, "enabled");

    // A revision that drops a name removes it from .env and from the environment.
    await applyState(local, "revision-1b", runtimeValues, { TOOL_PASSWORD: "tool-secret" });
    assert.throws(() => readSecretValue("TOOL_USER"), /no value for TOOL_USER/);
    assert.equal(readSecretValue("TOOL_PASSWORD"), "tool-secret");

    await applyState(local, "revision-2", {}, {});
    assert.equal(process.env.AGENT_TEST_SETTING, undefined);
    assert.throws(() => readSecretValue("TOOL_PASSWORD"), /no value for TOOL_PASSWORD/);
  } finally {
    delete process.env.AGENT_TEST_SETTING;
    delete process.env.ZIDANE_TEST_RUNTIME_VALUE;
    await rm(root, { recursive: true, force: true });
  }
});

// Startup used to die on a bare EPERM when it could not chmod a directory it did not own,
// which is what a bind mount seeded by a root `cp -a` looks like. A mode already no wider
// than the one being asked for has nothing wrong with it and must not stop the agent.
test("a directory is only a problem when it is more permissive than asked for", () => {
  assert.equal(permissionsSufficient(0o700, 0o700), true);
  assert.equal(permissionsSufficient(0o600, 0o700), true);
  assert.equal(permissionsSufficient(0o500, 0o700), true);
  assert.equal(permissionsSufficient(0o750, 0o700), false);
  assert.equal(permissionsSufficient(0o755, 0o700), false);
  assert.equal(permissionsSufficient(0o707, 0o700), false);
  // Type bits ride along in stat's mode and are not permissions.
  assert.equal(permissionsSufficient(0o40700, 0o700), true);
});

test("the working directory keeps its private mode across restarts", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zidane-perm-test-"));
  try {
    const config = { name: "test", version: "1", description: "test", capacity: 1, workingDirectory: root };
    const local = await initialise(config);
    await initialise(config);
    assert.equal((await stat(local.root)).mode & 0o777, 0o700);
    assert.equal((await stat(local.auth)).mode & 0o777, 0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
