import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { initialise } from "../src/config.mjs";
import { exportAgent, importAgent, validateArchive } from "../src/portable.mjs";

test("portable archives round-trip state and exclude secrets and sessions", async () => {
  const sourceRoot = await mkdtemp(resolve(tmpdir(), "zidane-export-test-"));
  const targetRoot = await mkdtemp(resolve(tmpdir(), "zidane-import-test-"));
  try {
    const source = await initialise({ name: "source", version: "1", description: "source", workingDirectory: sourceRoot });
    const target = await initialise({ name: "target", version: "1", description: "target", workingDirectory: targetRoot });
    await writeFile(source.soul, "# Soul\n\nBe exact.\n");
    await writeFile(resolve(source.memory, "memory.json"), "[]");
    await writeFile(resolve(source.secrets, "must-not-export"), "secret", { mode: 0o600 });
    await writeFile(resolve(source.sessions, "must-not-export.json"), "[]");

    const exported = await exportAgent(source, "portable.tar.gz");
    const entries = await validateArchive(exported.archive);
    assert.ok(entries.some((entry) => entry.path === "SOUL.md"));
    assert.ok(entries.every((entry) => !entry.path.startsWith("secrets/")));
    assert.ok(entries.every((entry) => !entry.path.startsWith("sessions/")));

    const result = await importAgent(target, exported.archive, "replace");
    assert.equal(result.status, "imported");
    assert.match(await readFile(target.soul, "utf8"), /Be exact/);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});
