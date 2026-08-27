import { access as canAccess, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { createBashToolDefinition, createEditToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Keep a session's scratch inside its own workspace.
 *
 * A conversation's workspace is deleted when the conversation is — that is what makes a
 * thread or a scheduled run leave nothing behind. Anything written to `$HOME`, `/tmp`, or
 * a cache directory escapes that: it survives the session, is shared with every other
 * session in the container, and on a scheduled task accumulates every night forever.
 *
 * The agent's own state lives under the working directory, so a session that could write
 * to `$HOME` could also reach `auth/`. Confinement is the point, not tidiness.
 *
 * Pi lets a custom tool shadow a built-in of the same name, so `bash`, `write`, and `edit`
 * are re-registered here with the workspace pinned. `read`, `grep`, `find`, and `ls` are
 * left alone: seeing the rest of the disk is not what causes the damage.
 */

/** Where a session's `$HOME` and temporary directory live inside its workspace. */
export function sandboxPaths(workspace) {
  return { home: resolve(workspace, ".home"), tmp: resolve(workspace, ".tmp") };
}

export async function prepareSandbox(workspace) {
  const paths = sandboxPaths(workspace);
  await Promise.all([mkdir(paths.home, { recursive: true }), mkdir(paths.tmp, { recursive: true })]);
  return paths;
}

/**
 * The environment every command in this session sees.
 *
 * `HOME` covers `~`, and the rest cover the several conventions a tool might reach for.
 * `ZIDANE_`/`AI_AGENT_` variables are already reserved from config maps, so nothing a
 * skill can set repoints these either.
 */
export function sandboxEnvironment(environment, { home, tmp }) {
  return {
    ...environment,
    HOME: home,
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
  throw new Error(
    `refusing to write outside this session's workspace: ${path}. `
    + `Write to a path inside ${workspace} — $HOME and $TMPDIR already point there.`,
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
