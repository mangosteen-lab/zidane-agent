import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { BusyError, PiRuntime } from "../src/runtime.mjs";
import { initialise } from "../src/config.mjs";

test("a conversation runs one prompt at a time, and capacity bounds the rest", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zidane-runtime-test-"));
  const emitted = [];
  try {
    const local = await initialise({ name: "t", version: "1", description: "", capacity: 2, workingDirectory: root });
    // No LLM profile is configured, so each admitted run fails on its own and reports
    // it. That is enough: what is under test is which prompts are admitted at all.
    const runtime = new PiRuntime({ capacity: 2 }, local, (type, body) => emitted.push([type, body]), null, null);

    runtime.prompt({ delivery_id: "d1", conversation_id: "thread-a", text: "one" });
    assert.equal(runtime.active, 1);

    // A second prompt for a running conversation would open a second Pi session over
    // the same workspace and session history.
    assert.throws(
      () => runtime.prompt({ delivery_id: "d2", conversation_id: "thread-a", text: "two" }),
      (error) => error instanceof BusyError && error.reason === "conversation",
    );

    runtime.prompt({ delivery_id: "d3", conversation_id: "thread-b", text: "three" });
    assert.equal(runtime.active, 2);

    // A different conversation is fine, until the capacity is used up.
    assert.throws(
      () => runtime.prompt({ delivery_id: "d4", conversation_id: "thread-c", text: "four" }),
      (error) => error instanceof BusyError && error.reason === "capacity",
    );

    // The same delivery arriving twice is ignored rather than refused.
    assert.equal(runtime.prompt({ delivery_id: "d1", conversation_id: "thread-a", text: "one" }), undefined);

    await Promise.allSettled([...runtime.activeTasks]);
    assert.equal(runtime.active, 0);
    // Both slots are free again, and so is the conversation that was held.
    runtime.prompt({ delivery_id: "d5", conversation_id: "thread-a", text: "five" });
    assert.equal(runtime.active, 1);
    await Promise.allSettled([...runtime.activeTasks]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
