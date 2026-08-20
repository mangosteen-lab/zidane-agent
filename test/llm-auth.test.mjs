import assert from "node:assert/strict";
import { test } from "node:test";
import { PiAuthManager } from "../src/llm-auth.mjs";

async function eventually(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not reached");
}

test("Pi auth relays interactive prompts and reports configured status", async () => {
  const sent = [];
  let selected = "";
  const fakeRuntime = {
    getProvider: () => ({ auth: { oauth: { name: "Subscription" } } }),
    login: async (_provider, _method, interaction) => {
      selected = await interaction.prompt({
        type: "select",
        message: "Choose login mode",
        options: [{ id: "device_code", label: "Device code" }],
      });
      interaction.notify({
        type: "device_code",
        userCode: "ABCD-EFGH",
        verificationUri: "https://example.test/device",
        expiresInSeconds: 900,
      });
    },
    checkAuth: async () => ({ type: "oauth", source: "test subscription" }),
  };
  const manager = new PiAuthManager({}, (type, fields) => sent.push({ type, ...fields }), null, async () => fakeRuntime);

  assert.equal(manager.start({ flow_id: "flow-1", provider: "openai-codex", auth_method: "oauth" }), true);
  const prompt = await eventually(() => sent.find((message) => message.type === "LLM_AUTH_PROMPT"));
  assert.equal(prompt.prompt.type, "select");
  assert.equal(manager.start({ flow_id: "flow-2", provider: "openai-codex", auth_method: "oauth" }), false);
  assert.equal(manager.input({ flow_id: "flow-1", prompt_id: prompt.prompt_id, value: "device_code" }), true);
  const done = await eventually(() => sent.find((message) => message.type === "LLM_AUTH_DONE"));

  assert.equal(selected, "device_code");
  assert.equal(done.configured, true);
  assert.equal(done.auth_method, "oauth");
  assert.ok(sent.some((message) => message.type === "LLM_AUTH_EVENT" && message.event.type === "device_code"));
});
