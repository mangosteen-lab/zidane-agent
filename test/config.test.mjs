import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { applyAgentInfo, applyState, initialise, readAgentSecret, readSessionToken, resolveLlmProfile, writeSessionToken } from "../src/config.mjs";
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
    await store.handle("secret.create", { name: "LOCAL_MODEL", values: { api_key: "model-secret" } });
    const stored = (await store.handle("llm.create", {
      name: "Local model",
      provider: "local-openai",
      model: "coder-model",
      secret_name: "LOCAL_MODEL",
      base_url: "http://127.0.0.1:11434/v1",
      api: "openai-completions",
      thinking_level: "high",
    })).item;
    // A single-key secret does not have to name its key.
    assert.equal(stored.secret_key, "api_key");
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
    assert.equal(await readAgentSecret(local, resolved.secret_name, resolved.secret_key), "model-secret");
    assert.deepEqual(await resolveLlmProfile(local, "no-such-profile-id").catch(() => "rejected"), "rejected");

    await assert.rejects(
      store.handle("llm.create", { name: "Missing secret", provider: "local-openai", model: "coder-model", secret_name: "ABSENT" }),
      /no secret named ABSENT/,
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
    await applyState(
      local,
      "revision-1",
      runtimeValues,
      {
        "session-token": { value: "must-not-replace-auth" },
        TOOL_PASSWORD: { password: "tool-secret", username: "tool-user" },
      },
    );
    assert.equal(process.env.AGENT_TEST_SETTING, "enabled");
    assert.notEqual(process.env.ZIDANE_TEST_RUNTIME_VALUE, "blocked");
    assert.equal(await readSessionToken(local), "rotating-session");
    assert.equal(await readSessionToken(local), "rotating-session");
    assert.equal(await readFile(resolve(local.syncedSecrets, "session-token", "value"), "utf8"), "must-not-replace-auth");
    assert.equal(await readFile(resolve(local.syncedSecrets, "TOOL_PASSWORD", "username"), "utf8"), "tool-user");
    assert.equal((await stat(resolve(local.syncedSecrets, "TOOL_PASSWORD", "password"))).mode & 0o777, 0o600);
    assert.equal((await stat(resolve(local.syncedSecrets, "TOOL_PASSWORD"))).mode & 0o777, 0o700);
    delete process.env.AGENT_TEST_SETTING;
    await initialise({ name: "test", version: "1", description: "test", workingDirectory: root });
    assert.equal(process.env.AGENT_TEST_SETTING, "enabled");

    // A revision that drops one key of a secret removes just that file.
    await applyState(local, "revision-1b", runtimeValues, { TOOL_PASSWORD: { password: "tool-secret" } });
    await assert.rejects(readFile(resolve(local.syncedSecrets, "TOOL_PASSWORD", "username")), { code: "ENOENT" });
    assert.equal(await readFile(resolve(local.syncedSecrets, "TOOL_PASSWORD", "password"), "utf8"), "tool-secret");
    await assert.rejects(readFile(resolve(local.syncedSecrets, "session-token", "value")), { code: "ENOENT" });

    await applyState(local, "revision-2", {}, {});
    assert.equal(process.env.AGENT_TEST_SETTING, undefined);
    await assert.rejects(readFile(resolve(local.syncedSecrets, "TOOL_PASSWORD", "password")), { code: "ENOENT" });
  } finally {
    delete process.env.AGENT_TEST_SETTING;
    delete process.env.ZIDANE_TEST_RUNTIME_VALUE;
    await rm(root, { recursive: true, force: true });
  }
});
