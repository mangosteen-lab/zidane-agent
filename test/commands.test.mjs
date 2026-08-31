import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { DEFAULT_WATCH_MINUTES, expandCommand, looksLikeCommand, matchSkill, parseCommand } from "../src/commands.mjs";

/** A skills directory holding one skill per name. */
async function skillRoot(names) {
  const root = await mkdtemp(resolve(tmpdir(), "zidane-commands-test-"));
  for (const name of names) {
    const directory = resolve(root, name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      resolve(directory, "SKILL.md"),
      `---\nname: ${name}\ndescription: Fills a pull request in.\n---\n\n# ${name}\n\nDo the thing.\n`,
    );
  }
  return root;
}

test("a command is the first token of a message, with the rest as its input", () => {
  assert.deepEqual(parseCommand("$pr-fill https://github.com/o/r/pull/13764"), {
    name: "pr-fill",
    argument: "https://github.com/o/r/pull/13764",
    body: "",
  });
  // Everything after the first line stays with the prompt as context.
  assert.deepEqual(parseCommand("$pr-fill 13764\nkeep the summary short"), {
    name: "pr-fill",
    argument: "13764",
    body: "keep the summary short",
  });
  assert.deepEqual(parseCommand("$deploy"), { name: "deploy", argument: "", body: "" });
  // Not a command: a dollar anywhere but the front, or one that opens with a digit.
  assert.equal(parseCommand("run $pr-fill please"), null);
  assert.equal(parseCommand("$5 for coffee"), null);
  assert.equal(looksLikeCommand("plain text"), false);
});

test("a skill is matched by name, however it was capitalised or joined", () => {
  const skills = [{ name: "pr-fill", directory: "/x/pr-fill" }, { name: "Deploy Notes", directory: "/x/deploy" }];
  assert.equal(matchSkill("PR_Fill", skills).name, "pr-fill");
  assert.equal(matchSkill("deploy-notes", skills).name, "Deploy Notes");
  assert.equal(matchSkill("nothing", skills), null);
});

test("a known command becomes an instruction naming the skill file", async () => {
  const root = await skillRoot(["pr-fill"]);
  try {
    const resolved = await expandCommand("$pr-fill https://github.com/o/r/pull/13764", root);
    assert.equal(resolved.skill, "pr-fill");
    assert.match(resolved.text, /Use the `pr-fill` skill/);
    // It points at the file rather than inlining it, so the session reads it itself.
    assert.match(resolved.text, new RegExp(`${root}/pr-fill/SKILL\\.md`));
    assert.match(resolved.text, /Input: https:\/\/github\.com\/o\/r\/pull\/13764/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a command naming no installed skill is left as ordinary text", async () => {
  const root = await skillRoot(["pr-fill"]);
  try {
    const resolved = await expandCommand("$HOME is where the config lives", root);
    assert.equal(resolved.text, "$HOME is where the config lives");
    assert.equal(resolved.skill, null);
    assert.equal(resolved.unknown, "HOME");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("$watch carries the person's own interval, and needs no skill installed", async () => {
  const root = await skillRoot([]);
  try {
    const asked = await expandCommand("$watch 15 the release build at https://ci.example.test/42", root);
    assert.equal(asked.skill, "$watch");
    assert.match(asked.text, /every 15 minutes/);
    assert.match(asked.text, /This is what they asked for/);
    assert.match(asked.text, /check_back with minutes: 15/);
    assert.match(asked.text, /the release build at https:\/\/ci\.example\.test\/42/);

    // No number: the agent still watches, on the default rather than a guess.
    const bare = await expandCommand("$watch the deploy", root);
    assert.match(bare.text, new RegExp(`every ${DEFAULT_WATCH_MINUTES} minutes`));
    assert.match(bare.text, /What to watch: the deploy/);

    // Nothing at all: it watches what the conversation was already about.
    assert.match((await expandCommand("$watch", root)).text, /whatever this conversation was just about/);

    // Out of range is clamped rather than refused: the intent is plain either way.
    assert.match((await expandCommand("$watch 0 x", root)).text, /every 1 minutes/);
    assert.match((await expandCommand("$watch 9999 x", root)).text, /every 1440 minutes/);

    const stopped = await expandCommand("$unwatch", root);
    assert.equal(stopped.skill, "$unwatch");
    assert.match(stopped.text, /stop_checking/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a built-in name means the same thing whatever skills an agent has", async () => {
  const root = await skillRoot(["watch"]);
  try {
    // A skill called `watch` does not quietly redefine `$watch` on one agent.
    const resolved = await expandCommand("$watch 5 something", root);
    assert.equal(resolved.skill, "$watch");
    assert.match(resolved.text, /check_back with minutes: 5/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
