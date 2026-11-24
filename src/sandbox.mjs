import { access as canAccess, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { createBashToolDefinition, createEditToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Where a session's work goes, and what it keeps.
 *
 * Two lifetimes, on purpose:
 *
 *   the workspace   `workspaces/<conversation_id>`, deleted with the conversation.
 *                   Clones, build trees, scratch files, `$TMPDIR`. This is what makes a
 *                   thread or a scheduled run leave nothing behind.
 *   the home        one directory shared by every session, on the agent's volume. Tool
 *                   installations and tool configuration: `~/.local/bin`, `~/.config/gh`,
 *                   `~/.gitconfig`, package caches. A session cannot use apt and its
 *                   workspace is thrown away, so without somewhere durable it would
 *                   reinstall the same tool on every prompt.
 *
 * The home is a *subdirectory* of the working directory rather than the working
 * directory itself, which matters: `auth/`, `config-maps/`, `memory/`, and every other
 * session's workspace are then siblings of `$HOME`, not children of it. A tool that
 * writes to `~/.config`, or a glob over `~`, cannot reach the agent's own credentials by
 * accident. Point `home` at the root instead and they all become things inside `$HOME`.
 *
 * Pi lets a custom tool shadow a built-in of the same name, so `bash`, `write`, and `edit`
 * are re-registered here with the workspace pinned — the write tools stay confined even
 * though `bash` now has somewhere durable to install into. `read`, `grep`, `find`, and
 * `ls` are left alone: seeing the rest of the disk is not what causes the damage.
 */

/**
 * Where a session's workspace, shared `$HOME`, and temporary directory are.
 *
 * `git` is `gitCacheSettings()` from git-cache.mjs, or null: with it, `git clone` in
 * this session goes through the shared mirror.
 */
export function sandboxPaths(workspace, home, git = null) {
  const root = resolve(workspace);
  return { workspace: root, home: resolve(home), tmp: resolve(root, ".tmp"), git };
}

export async function prepareSandbox(workspace, home, git = null) {
  const paths = sandboxPaths(workspace, home, git);
  // The home outlives the conversation; creating it is idempotent, and a session that
  // runs before anything has ever been installed still needs it to exist.
  await Promise.all([mkdir(paths.home, { recursive: true }), mkdir(paths.tmp, { recursive: true })]);
  return paths;
}

/**
 * The agent's own configuration, which is the agent's business and nobody else's.
 *
 * `process.env` is where the agent keeps how it reaches its control plane, and
 * `ZIDANE_AGENT_API_KEY` is the registration key itself — the one that exchanges for
 * session tokens, and the one thing in the container that is not merely a credential
 * for some third-party service but the credential for the account. Pi hands the bash
 * tool `{...process.env}`, so all of it was reaching every command a session runs: an
 * `echo` away from a key that registers another agent on the account and then asks it
 * for every secret the account shares.
 *
 * Stripping the whole prefix is safe *because* it is reserved: a config map may not
 * define a `ZIDANE_`-prefixed value (`isRuntimeEnvironmentKey` refuses it), so this can
 * never take away a value somebody meant a tool to have. What a session is supposed to
 * find is `AI_AGENT_*` — the config-maps folder, the knowledge folder, its own
 * workspace — and those stay exactly where they were.
 *
 * It is not a boundary, and must not be read as one. A session runs as the same user as
 * the agent, so `/proc/<agent pid>/environ` is readable to it whatever this does, and
 * clearing the variable in-process does not scrub that (the kernel keeps the exec-time
 * copy). What this removes is the casual path: an `env` dump into a transcript, a
 * script that logs its environment, a tool that reports what it was given. A real
 * boundary needs sessions running as a different user.
 */
function withoutAgentConfig(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => !key.startsWith("ZIDANE_")),
  );
}

/**
 * The environment every command in this session sees.
 *
 * It starts from the agent's own environment with the agent's own configuration taken
 * out — see `withoutAgentConfig`. What is left is what a session is meant to have: the
 * values its config maps and connectors supply, and the `AI_AGENT_*` paths.
 *
 * `HOME` and the XDG directories point at the shared home, so a tool installed or
 * configured once is there for the next conversation: `gh auth login` writes
 * `~/.config/gh`, `npm i -g --prefix ~/.local` lands in `~/.local/bin`, and a package
 * cache is reused rather than refetched. `ZIDANE_`/`AI_AGENT_` variables are reserved
 * from config maps, so nothing a skill can set repoints any of this.
 *
 * `PATH` gains `~/.local/bin`, which is what makes installing a tool worth doing: the
 * conventional prefix for an unprivileged install (`npm i -g --prefix ~/.local`,
 * `pip install --user`, a binary dropped in by hand) is then on the path by name in
 * every later conversation. It goes in front, so a newer tool installed there wins over
 * the image's copy — which is the point, and also means one session can shadow a system
 * tool for the rest: what is installed there is shared, like everything else in `~`.
 *
 * `TMPDIR` stays in the workspace. Temporary is temporary: it should die with the
 * conversation, and a shared `/tmp` is how a container fills up.
 *
 * `AI_AGENT_SESSION_WORKSPACE_DIR` is the one a skill is meant to read: the directory
 * this session owns. A clone or a build tree belongs there — too big to want in
 * `$TMPDIR`, too disposable to want in `~`. Unlike `AI_AGENT_CONFIG_MAPS_FOLDER`, which
 * the image sets once, this one differs per session and exists only inside one.
 */
export function sandboxEnvironment(environment, { workspace, home, tmp, git = null }) {
  const local = resolve(home, ".local", "bin");
  // The git wrapper goes in front of everything, ~/.local/bin included: it is the
  // agent's, not the session's, and a git installed there is not one it should skip.
  const leading = git ? [git.bin, local] : [local];
  const path = (environment.PATH ?? "").split(":").filter(Boolean);
  return {
    ...withoutAgentConfig(environment),
    AI_AGENT_SESSION_WORKSPACE_DIR: workspace,
    // `git clone <remote>` through the shared mirror (git-cache.mjs). `AI_AGENT_` is
    // reserved from config maps, so nothing a skill sets can repoint these.
    ...(git ? {
      AI_AGENT_GIT: git.git,
      AI_AGENT_GIT_CACHE_DIR: resolve(home, ".cache", "zidane", "repos"),
      AI_AGENT_NODE: git.node,
    } : {}),
    HOME: home,
    PATH: [...leading, ...path.filter((entry) => !leading.includes(entry))].join(":"),
    TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    XDG_CACHE_HOME: resolve(home, ".cache"),
    XDG_CONFIG_HOME: resolve(home, ".config"),
    XDG_DATA_HOME: resolve(home, ".local", "share"),
    XDG_STATE_HOME: resolve(home, ".local", "state"),
  };
}

/** True when `path` is the workspace or something inside it. */
export function withinWorkspace(workspace, path) {
  const target = isAbsolute(path) ? resolve(path) : resolve(workspace, path);
  const step = relative(resolve(workspace), target);
  return step === "" || (!step.startsWith("..") && !isAbsolute(step));
}

function guard(workspace, path) {
  if (withinWorkspace(workspace, path)) return isAbsolute(path) ? resolve(path) : resolve(workspace, path);
  // Said plainly, because the model is the one that has to recover from it: an absolute
  // path outside the workspace is a mistake it can fix by writing a relative one instead.
  // `bash` is the way to touch $HOME — that is where installing and configuring a tool
  // happens, and it is deliberately not something the file tools can do by accident.
  throw new Error(
    `refusing to write outside this session's workspace: ${path}. `
    + `Write to a path inside ${workspace} — $TMPDIR already points there. `
    + `To configure a tool in the shared $HOME, run the command with bash.`,
  );
}

/**
 * The workspace-pinned `bash`, `write`, and `edit` tools for one session.
 *
 * Pass alongside the session's other custom tools; Pi resolves the name collision in
 * favour of these, and the allowlist still has to name them.
 */
export function sandboxTools(workspace, paths) {
  return [
    createBashToolDefinition(workspace, {
      spawnHook: (context) => ({
        ...context,
        // A command may legitimately cd elsewhere to read; it starts in the workspace.
        cwd: withinWorkspace(workspace, context.cwd ?? workspace) ? context.cwd : workspace,
        env: sandboxEnvironment(context.env, paths),
      }),
    }),
    createWriteToolDefinition(workspace, {
      operations: {
        writeFile: (path, content) => writeFile(guard(workspace, path), content),
        mkdir: (directory) => mkdir(guard(workspace, directory), { recursive: true }),
      },
    }),
    createEditToolDefinition(workspace, {
      operations: {
        readFile: (path) => readFile(guard(workspace, path)),
        writeFile: (path, content) => writeFile(guard(workspace, path), content),
        access: (path) => canAccess(guard(workspace, path), constants.R_OK | constants.W_OK),
      },
    }),
  ];
}
