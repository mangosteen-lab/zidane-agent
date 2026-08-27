import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { prepareSandbox, sandboxEnvironment, sandboxTools, withinWorkspace } from "../src/sandbox.mjs";
test("a session's scratch is pinned to its workspace whatever a skill asks for", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zidane-sandbox-test-"));
  try {
    const workspace = resolve(root, "workspaces", "conversation-1");
    const paths = await prepareSandbox(workspace);

    // $HOME and the temporary directory land inside the workspace, so scratch dies with
    // the conversation rather than accumulating in the container.
    const environment = sandboxEnvironment({ PATH: "/usr/bin", HOME: "/root", TMPDIR: "/tmp" }, paths);
    assert.equal(environment.HOME, resolve(workspace, ".home"));
    assert.equal(environment.TMPDIR, resolve(workspace, ".tmp"));
    assert.equal(environment.TMP, environment.TMPDIR);
    assert.equal(environment.XDG_CACHE_HOME, resolve(workspace, ".home", ".cache"));
    assert.equal(environment.PATH, "/usr/bin");
    assert.equal((await stat(paths.home)).isDirectory(), true);

    assert.equal(withinWorkspace(workspace, "notes.md"), true);
    assert.equal(withinWorkspace(workspace, resolve(workspace, "deep", "notes.md")), true);
    assert.equal(withinWorkspace(workspace, workspace), true);
    // The agent's own credentials sit under the same root as the workspaces.
    assert.equal(withinWorkspace(workspace, resolve(root, "auth", "session-token")), false);
    assert.equal(withinWorkspace(workspace, "/root/.bashrc"), false);
    assert.equal(withinWorkspace(workspace, `${workspace}/../conversation-2/notes.md`), false);

    // The pinned tools shadow Pi's built-ins of the same name.
    assert.deepEqual(sandboxTools(workspace, paths).map((tool) => tool.name), ["bash", "write", "edit"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
