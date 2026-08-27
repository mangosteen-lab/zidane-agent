import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { DailyJournal, today } from "../src/daily.mjs";
import { MemoryStore } from "../src/memory.mjs";
import { initialise } from "../src/config.mjs";

/** Stands in for the model: records what it was asked, answers with a fixed summary. */
function fakeRuntime(answer = "Spent the day on NFS.") {
  const prompts = [];
  return {
    prompts,
    async summarise(conversation, prompt) { prompts.push({ conversation, prompt }); return answer; },
  };
}

test("the day's work is journalled and summarised into memory once the day is over", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zidane-daily-test-"));
  try {
    const local = await initialise({ name: "t", version: "1", description: "", capacity: 1, workingDirectory: root });
    const journal = new DailyJournal(local, null);
    const memory = new MemoryStore(local);

    // Today's own entries are never digested: the day is not over.
    await journal.record({ conversation: "thread-a", prompt: "set up NFS", answer: "Installed nfs-utils.", status: "completed" });
    assert.deepEqual(await journal.pending(), []);
    assert.equal(await journal.digest(fakeRuntime(), memory), null);

    // A finished day is.
    const yesterday = "2026-08-26";
    await writeFile(
      resolve(local.memory, "journal", `${yesterday}.jsonl`),
      [
        JSON.stringify({ at: `${yesterday}T09:00:00Z`, conversation: "thread-a", prompt: "set up NFS", answer: "Installed nfs-utils.", status: "completed" }),
        JSON.stringify({ at: `${yesterday}T15:00:00Z`, conversation: "thread-b", prompt: "check the build", answer: "Build is green.", status: "completed" }),
      ].join("\n") + "\n",
    );
    assert.deepEqual(await journal.pending(), [yesterday]);

    const runtime = fakeRuntime();
    const result = await journal.digest(runtime, memory);
    assert.equal(result.date, yesterday);
    assert.equal(result.entries, 2);
    // The model is given the day's entries, not the raw transcripts.
    assert.match(runtime.prompts[0].prompt, /set up NFS/);
    assert.match(runtime.prompts[0].prompt, /check the build/);

    const stored = await memory.query("NFS");
    assert.equal(stored.length, 1);
    assert.deepEqual(stored[0].tags.sort(), [yesterday, "daily"]);

    // A digested day is not digested twice.
    assert.deepEqual(await journal.pending(), []);
    assert.equal(await journal.digest(fakeRuntime(), memory), null);

    // A day whose model call comes back empty stays pending, rather than being lost.
    const older = "2026-08-20";
    await writeFile(
      resolve(local.memory, "journal", `${older}.jsonl`),
      JSON.stringify({ at: `${older}T09:00:00Z`, conversation: "thread-c", prompt: "x", answer: "y", status: "completed" }) + "\n",
    );
    // Older than the last digested day, so it is already past — nothing re-opens it.
    assert.deepEqual(await journal.pending(), []);

    // Today's file is still there to be digested tomorrow.
    const files = await readdir(resolve(local.memory, "journal"));
    assert.ok(files.includes(`${today()}.jsonl`));
    assert.ok(JSON.parse(await readFile(resolve(local.memory, "journal", "state.json"), "utf8")).digested === yesterday);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
