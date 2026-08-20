import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { applyAgentInfo, applyLlmProfile, applyState, initialise, readSessionToken, writeSessionToken } from "../src/config.mjs";

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

    const stored = await applyLlmProfile(local, {
      profile_id: "profile-1",
      name: "Local model",
      provider: "local-openai",
      model: "coder-model",
      credential: "model-secret",
      base_url: "http://127.0.0.1:11434/v1",
      api: "openai-completions",
      thinking_level: "high",
      set_default: true,
    });
    assert.equal(stored.secret_name, "llm-profile-profile-1");
    assert.equal(await readFile(resolve(local.secrets, stored.secret_name), "utf8"), "model-secret");
    const profileFile = await readFile(resolve(local.config, "default-llm-profile.json"), "utf8");
    const modelsFile = await readFile(resolve(local.config, "models.json"), "utf8");
    assert.doesNotMatch(profileFile, /model-secret/);
    assert.doesNotMatch(modelsFile, /model-secret/);
    assert.equal(JSON.parse(modelsFile).providers["local-openai"].models[0].id, "coder-model");

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
