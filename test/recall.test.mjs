import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { initialise } from "../src/config.mjs";
import { MemoryStore } from "../src/memory.mjs";
import { RECALL_TYPE, recallExtension, recallGuidance, terms } from "../src/recall.mjs";

const CLONE_FIX =
  "Triggered QA multi-tenant API gateway search run. Initial clone of `qhu/mstr-test-scripts` failed due to "
  + "SSH publickey permission. User said to use `GITHUB_PRIVATE_RSA` as the private Git RSA key; after "
  + "configuring that, triggered the job.";

const CLONE_ERROR =
  "Cloning into 'mstr-test-scripts'...\ngit@tec-l-1203160.labs.microstrategy.com: Permission denied (publickey).\n"
  + "fatal: Could not read from remote repository.\n\nCommand exited with code 128";

async function fixture(callback) {
  const root = await mkdtemp(resolve(tmpdir(), "zidane-recall-test-"));
  try {
    const local = await initialise({ name: "t", version: "1", description: "", workingDirectory: root });
    const memory = new MemoryStore(local);
    await memory.add({ text: CLONE_FIX, tags: ["daily", "2026-08-31"] });
    await memory.add({ text: "Checked a featureHistoryList job; the quality gate passed with 45/0/0.", tags: ["daily"] });
    await memory.add({ text: "The person prefers release notes written as bullet points.", tags: ["preference"] });
    await memory.add({ text: "Deploy key for mstr-test-scripts over SSH publickey.", sensitivity: "restricted" });
    await writeFile(resolve(local.knowledge, "index.json"), JSON.stringify([
      { source_id: "a1", title: "Test scripts repository", text: "mstr-test-scripts is cloned over SSH on port 22222.", chunk: 0 },
      { source_id: "a1", title: "Test scripts repository", text: "Its Behave suites live under featureSearch.", chunk: 1 },
      { source_id: "a2", title: "Holiday calendar", text: "Offices close for the new year.", chunk: 0 },
    ]));
    const handlers = new Map();
    const logs = [];
    const extension = recallExtension({ memory, local, logger: { log: (...entry) => logs.push(entry) } });
    await extension.factory({ on: (name, handler) => handlers.set(name, handler) });
    await callback({ memory, local, handlers, logs });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("terms drop filler and keep a compound whole as well as in parts", () => {
  const found = terms("Use the `qhu/mstr-test-scripts` repo, exited with code 128");
  assert.ok(found.has("mstr-test-scripts") && found.has("mstr") && found.has("scripts") && found.has("qhu"));
  for (const filler of ["use", "the", "with", "exited", "code", "128"]) assert.equal(found.has(filler), false);
});

test("a failed tool is answered with the memory and knowledge that solved it before", async () => {
  await fixture(async ({ handlers, logs }) => {
    const content = [{ type: "text", text: CLONE_ERROR }];
    const event = {
      type: "tool_result", toolName: "bash", isError: true, content,
      input: { command: "git clone ssh://git@tec-l-1203160.labs.microstrategy.com:22222/qhu/mstr-test-scripts.git" },
    };
    const result = await handlers.get("tool_result")(event);
    // The error the model was going to read is still there, first.
    assert.deepEqual(result.content[0], content[0]);
    const appended = result.content.at(-1).text;
    assert.match(appended, /GITHUB_PRIVATE_RSA/);
    assert.match(appended, /Test scripts repository/);
    // Restricted memory is never recalled, and unrelated notes are not dragged in.
    assert.doesNotMatch(appended, /Deploy key|quality gate|bullet points|Holiday/);
    // One article is shown once, however many of its chunks matched.
    assert.equal(appended.match(/Test scripts repository/g).length, 1);
    assert.ok(logs.some(([, message]) => message === "recalled for error"));

    // The same failure again in the same session is not answered with the same notes.
    assert.equal(await handlers.get("tool_result")(event), undefined);
  });
});

test("a successful tool, a memory tool, and an ordinary miss are left alone", async () => {
  await fixture(async ({ handlers }) => {
    const onResult = handlers.get("tool_result");
    assert.equal(await onResult({ toolName: "bash", isError: false, content: [{ type: "text", text: CLONE_ERROR }], input: {} }), undefined);
    assert.equal(await onResult({ toolName: "retrieve_memory", isError: true, content: [{ type: "text", text: CLONE_ERROR }], input: {} }), undefined);
    assert.equal(await onResult({ toolName: "bash", isError: true, content: [{ type: "text", text: "(no output)\n\nCommand exited with code 1" }], input: { command: "grep -rn needle src" } }), undefined);
  });
});

test("a prompt carries a hidden recall note only when something bears on it", async () => {
  await fixture(async ({ memory, handlers }) => {
    const onStart = handlers.get("before_agent_start");
    const result = await onStart({ prompt: "Run the API gateway search suite; clone mstr-test-scripts first." });
    assert.equal(result.message.customType, RECALL_TYPE);
    assert.equal(result.message.display, false);
    assert.match(result.message.content, /GITHUB_PRIVATE_RSA/);
    assert.equal(result.systemPrompt, undefined);
    // Being recalled is being used.
    const [entry] = await memory.query("GITHUB_PRIVATE_RSA", 1);
    assert.ok(entry.access_count >= 1);

    assert.equal(await onStart({ prompt: "Write a haiku about autumn." }), undefined);

    // A later prompt in the same conversation does not repeat a note its context still holds.
    const context = {
      sessionManager: {
        buildContextEntries: () => [{ type: "custom_message", customType: RECALL_TYPE, details: result.message.details }],
      },
    };
    assert.equal(await onStart({ prompt: "Clone mstr-test-scripts again over SSH." }, context), undefined);
  });
});

test("a broken store skips recall instead of failing the prompt", async () => {
  const logs = [];
  const handlers = new Map();
  const memory = { recall: async () => { throw new Error("disk on fire"); } };
  const extension = recallExtension({ memory, local: { knowledge: "/nonexistent" }, logger: { log: (...entry) => logs.push(entry) } });
  await extension.factory({ on: (name, handler) => handlers.set(name, handler) });
  assert.equal(await handlers.get("before_agent_start")({ prompt: "clone mstr-test-scripts" }), undefined);
  assert.equal(logs[0][1], "recall skipped");
});

test("the guidance names only the search tools a session actually has", () => {
  const all = recallGuidance();
  assert.match(all, /`retrieve_memory` and `search_knowledge`/);
  assert.match(all, /Before starting a task/);
  assert.match(all, /After a command or tool fails/);
  assert.match(recallGuidance(["bash", "search_knowledge"]), /search with `search_knowledge` for/);
  const none = recallGuidance(["bash", "read"]);
  assert.doesNotMatch(none, /retrieve_memory|search_knowledge/);
  assert.match(none, /appended to its result/);
});
