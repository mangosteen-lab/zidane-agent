import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { expandCommand, looksLikeCommand, matchSkill, parseCommand } from "../src/commands.mjs";

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
