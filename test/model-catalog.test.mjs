import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { initialise } from "../src/config.mjs";
import { loadModelCatalog } from "../src/model-catalog.mjs";

test("model catalog comes from the bundled Pi SDK", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zidane-model-catalog-test-"));
  try {
    const local = await initialise({
      name: "test",
      version: "1",
      description: "test",
      capacity: 1,
      workingDirectory: root,
    });
    const catalog = await loadModelCatalog(local);
    const openai = catalog.find((provider) => provider.id === "openai");
    const openaiCodex = catalog.find((provider) => provider.id === "openai-codex");
    const anthropic = catalog.find((provider) => provider.id === "anthropic");

    assert.ok(openai);
    assert.ok(openai.models.some((model) => model.id === "gpt-4.1"));
    assert.deepEqual(openai.auth.map((method) => method.type), ["api_key"]);
    assert.ok(openaiCodex);
    assert.ok(openaiCodex.models.some((model) => model.id === "gpt-5.6-sol"));
    assert.deepEqual(openaiCodex.auth, [
      {
        type: "oauth",
        name: "OpenAI (ChatGPT Plus/Pro)",
        subscription: true,
      },
    ]);
    assert.ok(anthropic);
    assert.ok(anthropic.models.length > 0);
    assert.deepEqual(anthropic.auth.map((method) => method.type), ["api_key", "oauth"]);
    assert.ok(catalog.every((provider) => provider.models.length > 0));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
