import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { prepareSandbox, sandboxEnvironment, sandboxTools, withinWorkspace } from "../src/sandbox.mjs";

test("a session's scratch is pinned to its workspace whatever a skill asks for", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zidane-sandbox-test-"));
  try {
    const workspace = resolve(root, "workspaces", "conversation-1");
    const home = resolve(root, "home");
    const paths = await prepareSandbox(workspace, home);

    // Temporary files land in the workspace, so they die with the conversation rather
    // than accumulating in the container.
    const environment = sandboxEnvironment({ PATH: "/usr/bin", HOME: "/root", TMPDIR: "/tmp" }, paths);
    assert.equal(environment.TMPDIR, resolve(workspace, ".tmp"));
    assert.equal(environment.TMP, environment.TMPDIR);
    assert.equal(environment.TEMP, environment.TMPDIR);
    // An unprivileged install goes to ~/.local/bin, so that is on the path — in front,
    // so a tool installed there wins over the image's copy.
    assert.equal(environment.PATH, `${resolve(home, ".local", "bin")}:/usr/bin`);
    // Adding it twice would grow the path a little on every session.
    assert.equal(
      sandboxEnvironment({ PATH: environment.PATH }, paths).PATH,
      environment.PATH,
    );

    // $HOME is the agent's own, shared by every session: a tool installed or configured
    // once is still there for the next conversation.
    assert.equal(environment.HOME, home);
    assert.equal(environment.XDG_CONFIG_HOME, resolve(home, ".config"));
    assert.equal(environment.XDG_CACHE_HOME, resolve(home, ".cache"));
    assert.equal(environment.XDG_DATA_HOME, resolve(home, ".local", "share"));
    assert.equal((await stat(paths.home)).isDirectory(), true);

    // What a skill reads when it needs somewhere to clone into or build in: the session's
    // own workspace, which is deleted with the conversation. It is per-session, so it
    // overrides whatever the container was started with.
    assert.equal(environment.AI_AGENT_SESSION_WORKSPACE_DIR, workspace);
    assert.equal(withinWorkspace(workspace, environment.AI_AGENT_SESSION_WORKSPACE_DIR), true);
    assert.equal(
      sandboxEnvironment({ AI_AGENT_SESSION_WORKSPACE_DIR: "/somewhere/else" }, paths).AI_AGENT_SESSION_WORKSPACE_DIR,
      workspace,
    );

    assert.equal(withinWorkspace(workspace, "notes.md"), true);
    assert.equal(withinWorkspace(workspace, resolve(workspace, "deep", "notes.md")), true);
    assert.equal(withinWorkspace(workspace, workspace), true);
    // The agent's own credentials sit under the same root as the workspaces, and the
    // file tools stay out of them — and out of the shared home.
    assert.equal(withinWorkspace(workspace, resolve(root, "auth", "session-token")), false);
    assert.equal(withinWorkspace(workspace, resolve(home, ".gitconfig")), false);
    assert.equal(withinWorkspace(workspace, "/root/.bashrc"), false);
    assert.equal(withinWorkspace(workspace, `${workspace}/../conversation-2/notes.md`), false);

    // The pinned tools shadow Pi's built-ins of the same name.
    assert.deepEqual(sandboxTools(workspace, paths).map((tool) => tool.name), ["bash", "write", "edit"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("what a session installs outlives it; what it scribbles does not", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zidane-sandbox-home-"));
  try {
    const home = resolve(root, "home");
    const first = resolve(root, "workspaces", "conversation-1");
    const firstPaths = await prepareSandbox(first, home);

    // A tool configures itself in $HOME, and writes scratch to $TMPDIR.
    await writeFile(resolve(firstPaths.home, ".gitconfig"), "[user]\n\tname = Zidane\n");
    await writeFile(resolve(firstPaths.tmp, "scratch"), "half-finished");

    // The conversation ends: its workspace goes, and $TMPDIR with it.
    await rm(first, { recursive: true, force: true });

    const second = await prepareSandbox(resolve(root, "workspaces", "conversation-2"), home);
    assert.equal(second.home, firstPaths.home);
    assert.match(await readFile(resolve(second.home, ".gitconfig"), "utf8"), /name = Zidane/);
    assert.notEqual(second.tmp, firstPaths.tmp);
    await assert.rejects(() => readFile(resolve(firstPaths.tmp, "scratch")), { code: "ENOENT" });

    // The home sits beside the agent's state, not around it: `$HOME/..` is the working
    // directory, so nothing a tool writes under `~` can land on auth/ or config-maps/.
    assert.equal(resolve(second.home, ".."), resolve(root));
    assert.equal(withinWorkspace(second.home, resolve(root, "auth")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the agent's own credentials do not travel into a session", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zidane-sandbox-env-test-"));
  try {
    const paths = await prepareSandbox(resolve(root, "workspaces", "c1"), resolve(root, "home"));
    const environment = sandboxEnvironment({
      PATH: "/usr/bin",
      // How the agent reaches its control plane. `ZIDANE_AGENT_API_KEY` is the
      // registration key: with it and the server URL, anything can register another
      // agent on the account and ask it for every secret the account shares. Pi hands
      // the bash tool the whole of `process.env`, so this used to reach every command
      // a session ran — an `echo` away from the model, and from a transcript.
      ZIDANE_AGENT_API_KEY: "zidane_registration_key",
      ZIDANE_AGENT_SERVER_URL: "wss://zidane.example.com",
      ZIDANE_AGENT_WORKING_DIRECTORY: root,
      // What a session is meant to have: its config maps' values, and the AI_AGENT_
      // paths a skill is documented to read.
      GH_TOKEN: "ghp_for_the_tools",
      AI_AGENT_CONFIG_MAPS_FOLDER: resolve(root, "config-maps"),
      AI_AGENT_KNOWLEDGE_FOLDER: resolve(root, "knowledge"),
    }, paths);

    assert.equal(Object.keys(environment).some((key) => key.startsWith("ZIDANE_")), false);
    assert.equal(environment.ZIDANE_AGENT_API_KEY, undefined);
    // Stripping the whole prefix can never take away a value somebody meant a tool to
    // have, because a config map is refused a `ZIDANE_`-prefixed name in the first place.
    assert.equal(environment.GH_TOKEN, "ghp_for_the_tools");
    assert.equal(environment.AI_AGENT_CONFIG_MAPS_FOLDER, resolve(root, "config-maps"));
    assert.equal(environment.AI_AGENT_KNOWLEDGE_FOLDER, resolve(root, "knowledge"));
    assert.equal(environment.AI_AGENT_SESSION_WORKSPACE_DIR, paths.workspace);
    assert.equal(environment.HOME, paths.home);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
