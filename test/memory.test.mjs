import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { initialise } from "../src/config.mjs";
import { MemoryStore } from "../src/memory.mjs";

test("memory writes are serialized, searchable, and sensitivity-aware", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zidane-memory-test-"));
  try {
    const local = await initialise({
      name: "test",
      version: "1.0.0",
      description: "test",
      workingDirectory: root,
    });
    const memory = new MemoryStore(local);
    const stored = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        memory.add({
          text: `Deployment rule ${index} requires review`,
          tags: ["deployment", `rule-${index}`],
          sensitivity: index === 39 ? "restricted" : "normal",
        }),
      ),
    );
    assert.equal(stored.length, 40);
    assert.equal((await memory.query("deployment", 100, false)).length, 39);
    assert.equal((await memory.query("deployment", 100, true)).length, 40);
    assert.equal(await memory.delete(stored[0].id), true);
    assert.equal((await memory.query("rule-0", 10, true)).length, 0);
    await assert.rejects(
      memory.add({ text: "api_key=sk-this-must-never-be-stored-123456" }),
      /credentials and secret material/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
