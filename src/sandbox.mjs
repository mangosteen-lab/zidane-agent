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

/** Where a session's workspace, shared `$HOME`, and temporary directory are. */
export function sandboxPaths(workspace, home) {
  const root = resolve(workspace);
  return { workspace: root, home: resolve(home), tmp: resolve(root, ".tmp") };
}

export async function prepareSandbox(workspace, home) {
  const paths = sandboxPaths(workspace, home);
  // The home outlives the conversation; creating it is idempotent, and a session that
  // runs before anything has ever been installed still needs it to exist.
  await Promise.all([mkdir(paths.home, { recursive: true }), mkdir(paths.tmp, { recursive: true })]);
  return paths;
}

/**
 * The environment every command in this session sees.
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
export function sandboxEnvironment(environment, { workspace, home, tmp }) {
  const local = resolve(home, ".local", "bin");
  const path = (environment.PATH ?? "").split(":").filter(Boolean);
  return {
    ...environment,
    AI_AGENT_SESSION_WORKSPACE_DIR: workspace,
    HOME: home,
    PATH: [local, ...path.filter((entry) => entry !== local)].join(":"),
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
