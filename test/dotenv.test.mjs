import assert from "node:assert/strict";
import { test } from "node:test";
import { formatEnv, parseEnv } from "../src/dotenv.mjs";

const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXkAAAA\nQyNTUxOQAAACA\n-----END OPENSSH PRIVATE KEY-----\n";

test("a multi-line secret survives the round trip", () => {
  // It did not, until this: the quotes came off and the escape did not, so an SSH key
  // arrived as one line with a literal backslash-n and failed at clone time, nowhere
  // near the cause.
  const back = parseEnv(formatEnv({ GIT_SSH_KEY: KEY }));
  assert.equal(back.GIT_SSH_KEY, KEY);
  assert.equal(back.GIT_SSH_KEY.split("\n").length, 5);

  // And it does not take its neighbours with it.
  const many = parseEnv(formatEnv({ A: "one", GIT_SSH_KEY: KEY, Z: "two" }));
  assert.deepEqual([many.A, many.Z], ["one", "two"]);
  assert.equal(many.GIT_SSH_KEY, KEY);
});

test("the values that already worked still work", () => {
  const values = {
    PLAIN: "value",
    SPACED: "two words",
    EQUALS: "a=b=c",
    QUOTE: 'say "hi"',
    BACKSLASH: "C:\\Users\\me",
    EMPTY: "",
    HASH: "not#a#comment",
  };
  assert.deepEqual(parseEnv(formatEnv(values)), values);
});

test("a hand-written file is read the way a person meant it", () => {
  const parsed = parseEnv([
    "# a comment",
    "",
    "BARE=plain",
    "export EXPORTED=fromShell",
    "SINGLE='no \\n unescaping here'",
    'WINDOWS="C:\\path\\to"',
    'REAL_MULTILINE="first',
    'second"',
    "SPACES  =  padded  ",
  ].join("\n"));

  assert.equal(parsed.BARE, "plain");
  assert.equal(parsed.EXPORTED, "fromShell");
  // Single quotes never unescape — the way to keep a backslash verbatim.
  assert.equal(parsed.SINGLE, "no \\n unescaping here");
  // Not valid JSON, so it falls back to the text between the quotes rather than
  // throwing away a Windows path or turning \t into a tab.
  assert.equal(parsed.WINDOWS, "C:\\path\\to");
  // Real newlines inside quotes are kept, which is how somebody pastes a key in.
  assert.equal(parsed.REAL_MULTILINE, "first\nsecond");
  assert.equal(parsed.SPACES, "padded");
});

test("a malformed line costs only itself", () => {
  const parsed = parseEnv([
    "GOOD=kept",
    "no-equals-sign",
    "=novalue",
    "bad key=skipped",
    'UNTERMINATED="runs off the end',
    "ALSO_GOOD=kept",
  ].join("\n"));
  assert.equal(parsed.GOOD, "kept");
  // An unterminated quote stops at the end of the file rather than swallowing what
  // follows — but it does consume the rest, so the last key is inside it.
  assert.equal(parsed["bad key"], undefined);
  assert.equal(parsed[""], undefined);
  assert.match(parsed.UNTERMINATED, /runs off the end/);
});

test("the file itself stays one line per ordinary value", () => {
  const file = formatEnv({ A: "one", B: "two" });
  assert.equal(file.trim().split("\n").filter((line) => line.includes("=")).length, 2);
  // Sorted, so a rewrite does not churn the diff.
  assert.ok(file.indexOf("A=") < file.indexOf("B="));
  assert.equal((file.match(/\n/g) || []).length, file.split("\n").length - 1);
});
