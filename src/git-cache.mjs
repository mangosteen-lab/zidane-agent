/**
 * One download per repository, however many sessions clone it.
 *
 * A big repository cloned by every conversation is minutes of network and gigabytes of
 * disk each time, and the obvious workaround — one shared working folder — means two
 * sessions editing the same files, which is why people ended up setting the agent's
 * capacity to 1. This keeps the download shared and the working files separate:
 *
 *   the mirror   `~/.cache/zidane/repos/<host>/<path>.git`, a bare repository holding a
 *                repository's branches and tags, fetched under a per-repository lock.
 *                In the shared `$HOME`, so it outlives conversations; never exported.
 *   the clone    wherever the command said, made *from the mirror* on local disk. Git
 *                hard-links the object files rather than copying them, so a multi-GB
 *                clone takes seconds and almost no disk — and is still a complete,
 *                independent repository. Removing the mirror can never break it.
 *
 * Afterwards `origin` is the URL that was asked for, so fetch, pull, push and branches
 * behave exactly as they would after an ordinary clone.
 *
 * It is reached two ways. `bin/git` stands in front of the real git on every session's
 * `PATH` and hands `git clone <remote>` here — so a literal command, a script, a skill
 * and a scheduled run all take the fast path without knowing it exists — and the
 * `checkout_repo` tool calls the same thing for a model that would rather ask. Anything
 * this does not understand is passed to the real git untouched: a shallow or bare clone,
 * a local path, `--reference`. Whatever goes wrong with the mirror, the clone falls back
 * to the ordinary one, so the worst case is the behaviour there was before.
 */

import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { mkdir, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The directory holding the `git` wrapper; agent-owned, read-only to a session in the image. */
export const WRAPPER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin");
/** A mirror fetched this recently is used as it stands: the clone fetches from origin anyway. */
export const FRESH_MS = 10 * 60_000;
/** A mirror nobody has cloned from for this long is removed. */
export const MIRROR_TTL_MS = 14 * 24 * 60 * 60_000;
/** A lock not renewed for this long belongs to a process that died holding it. */
const LOCK_STALE_MS = 5 * 60_000;
/** How long a clone waits for another session's mirror download before cloning plainly. */
const LOCK_WAIT_MS = 30 * 60_000;
const NOTE = "zidane:";

/** Where the mirrors live under a session home. */
export function mirrorRoot(home) {
  return resolve(home, ".cache", "zidane", "repos");
}

/**
 * What a session needs to route `git` through the wrapper, or null to leave git alone.
 *
 * Null when `ZIDANE_AGENT_GIT_CACHE=false`, or when there is no real git to hand to — a
 * wrapper with nothing behind it would break git outright rather than slow it down.
 */
export function gitCacheSettings(environment = process.env) {
  if (String(environment.ZIDANE_AGENT_GIT_CACHE ?? "").toLowerCase() === "false") return null;
  const git = realGit(environment.PATH);
  if (!git || !existsSync(resolve(WRAPPER_DIR, "git"))) return null;
  return { bin: WRAPPER_DIR, git, node: process.execPath };
}

/** The first `git` on PATH that is not the wrapper. */
export function realGit(path = "") {
  for (const entry of String(path).split(delimiter).filter(Boolean)) {
    if (resolve(entry) === WRAPPER_DIR) continue;
    const candidate = resolve(entry, "git");
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

const GLOBAL_WITH_VALUE = new Set(["-C", "-c"]);
const CLONE_WITH_VALUE = new Set([
  "-b", "--branch", "-o", "--origin", "-c", "--config", "--depth", "--shallow-since",
  "--shallow-exclude", "-u", "--upload-pack", "--template", "--reference",
  "--reference-if-able", "--separate-git-dir", "-j", "--jobs", "--filter",
  "--server-option", "--bundle-uri", "--ref-format",
]);
// What changes the shape of the clone in a way a local clone from a mirror would not
// honour, or asks for an object store of its own: left to git exactly as typed.
const PASS_THROUGH = new Set([
  "--depth", "--shallow-since", "--shallow-exclude", "--shallow-submodules", "--bare",
  "--mirror", "--reference", "--reference-if-able", "--dissociate", "--shared", "-s",
  "--local", "-l", "--no-local", "--separate-git-dir", "--filter", "--bundle-uri",
  "-o", "--origin", "-u", "--upload-pack", "--template",
]);

/**
 * The clone a command line asks for, or null when it is not one this should touch.
 *
 * `args` is everything after `git`. Global options before `clone` are kept — `-C dir`
 * moves where the clone lands — and only a remote URL is redirected.
 */
export function planClone(args) {
  const global = [];
  let index = 0;
  while (index < args.length && args[index] !== "clone") {
    const arg = args[index];
    if (GLOBAL_WITH_VALUE.has(arg)) {
      if (index + 1 >= args.length) return null;
      global.push(arg, args[index + 1]);
      index += 2;
    } else if (arg.startsWith("-")) {
      global.push(arg);
      index += 1;
    } else {
      return null;
    }
  }
  if (args[index] !== "clone") return null;
  const options = [];
  const positional = [];
  let ended = false;
  for (let at = index + 1; at < args.length; at += 1) {
    const arg = args[at];
    if (ended || !arg.startsWith("-") || arg === "-") {
      positional.push(arg);
      continue;
    }
    if (arg === "--") {
      ended = true;
      continue;
    }
    const name = arg.split("=")[0];
    // A cluster of short flags (`-qn`) could hide a value-taking one; not worth guessing.
    if (/^-[A-Za-z]{2,}$/.test(arg)) return null;
    if (PASS_THROUGH.has(name)) return null;
    options.push(arg);
    if (CLONE_WITH_VALUE.has(arg)) {
      if (at + 1 >= args.length) return null;
      options.push(args[at + 1]);
      at += 1;
    }
  }
  if (positional.length < 1 || positional.length > 2) return null;
  const [url, given] = positional;
  const key = mirrorKey(url);
  if (!key) return null;
  const directory = given ?? humanish(url);
  if (!directory) return null;
  const names = options.map((option) => option.split("=")[0]);
  return {
    global,
    options,
    url,
    key,
    directory,
    quiet: names.includes("-q") || names.includes("--quiet"),
    checkout: !(names.includes("-n") || names.includes("--no-checkout")),
    submodules: names.some((name) => name === "--recurse-submodules" || name === "--recursive"),
  };
}

/**
 * `<host>/<path>.git` for a remote URL, or null for anything else.
 *
 * Remote means a scheme git fetches over (`https`, `ssh`, `git`) or the scp form
 * `user@host:path`; a local path or `file://` is already on disk and gains nothing.
 * Credentials in the URL never reach the key, and https and ssh spellings of one
 * repository share a mirror. Every segment is checked, since this becomes a path.
 */
export function mirrorKey(url) {
  const value = String(url ?? "").trim();
  let host;
  let path;
  const scheme = /^(?:https?|ssh|git):\/\//i.test(value);
  const scp = /^[^@/\s]+@([^:/\s]+):(?!\/\/)(.+)$/.exec(value);
  if (scheme) {
    try {
      const parsed = new URL(value);
      host = parsed.hostname;
      path = decodeURIComponent(parsed.pathname);
    } catch {
      return null;
    }
  } else if (scp) {
    [, host, path] = scp;
  } else {
    return null;
  }
  host = String(host).toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  const segments = String(path).toLowerCase().replace(/^[/~]+/, "").replace(/\/+$/, "").replace(/\.git$/, "")
    .split("/").filter(Boolean);
  if (!segments.length || segments.length > 8) return null;
  if (segments.some((segment) => segment === "." || segment === ".." || !/^[a-z0-9._-]+$/.test(segment))) return null;
  return `${host}/${segments.join("/")}.git`;
}

/**
 * The directory `git clone <url>` makes when none is named, the way git names it: the
 * last path component, case kept, without a trailing `/`, `.git` or `/.git`.
 */
export function humanish(url) {
  const path = String(url ?? "").trim().replace(/\/+$/, "").replace(/\/\.git$/, "").replace(/\.git$/, "").replace(/\/+$/, "");
  return path.split(/[/:]/).pop() ?? "";
}

/** A URL with any password or token taken out, for anything that is shown or logged. */
export function withoutCredentials(text) {
  // `git@` and `ssh://git@` name an account, not a secret; anything else before the `@`
  // — `user:password`, or a bare token GitHub accepts in its place — is hidden.
  return String(text ?? "").replace(
    /(\b[a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi,
    (whole, scheme, user) => (user === "git" ? whole : `${scheme}***@`),
  );
}

function run(command, args, { cwd, env, stdio = ["ignore", "pipe", "pipe"], signal } = {}) {
  return new Promise((settle) => {
    let out = "";
    let err = "";
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio, signal });
    } catch (error) {
      settle({ code: 127, out, err: String(error?.message ?? error) });
      return;
    }
    child.stdout?.on("data", (chunk) => { out = (out + chunk).slice(-20_000); });
    child.stderr?.on("data", (chunk) => { err = (err + chunk).slice(-20_000); });
    child.on("error", (error) => settle({ code: 127, out, err: err + String(error?.message ?? error) }));
    child.on("close", (code) => settle({ code: code ?? 1, out, err }));
  });
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Hold `path` (a directory, so taking it is one atomic mkdir) while `work` runs.
 *
 * Renewed every minute it is held, so a first download that takes an hour is not taken
 * for a dead holder; a lock that stops being renewed is broken after LOCK_STALE_MS.
 */
export async function withLock(path, work, { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS } = {}) {
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(path);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const held = await stat(path).catch(() => null);
      if (held && Date.now() - held.mtimeMs > staleMs) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > waitMs) throw new Error("timed out waiting for another session to finish updating the mirror");
      await sleep(500);
    }
  }
  const renew = setInterval(() => {
    const at = new Date();
    utimes(path, at, at).catch(() => {});
  }, 60_000);
  renew.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(renew);
    await rm(path, { recursive: true, force: true });
  }
}

async function touch(path) {
  const at = new Date();
  try {
    await utimes(path, at, at);
  } catch {
    await writeFile(path, "");
  }
}

/**
 * Bring the mirror up to date with `url`, creating it the first time.
 *
 * Branches and tags only: a GitHub mirror of `refs/pull/*` is many times the size of the
 * repository, and nothing clones from it. `HEAD` follows the remote's default branch so
 * a clone checks out what an ordinary clone would. A fetch that fails on a mirror that
 * has worked before is not fatal — the clone fetches from origin itself — but a mirror
 * that never completed a fetch is removed, so the next attempt starts clean.
 */
export async function refreshMirror(git, mirror, url, { env, freshMs = FRESH_MS } = {}) {
  await mkdir(dirname(mirror), { recursive: true });
  return withLock(`${mirror}.lock`, async () => {
    const fetched = resolve(mirror, "zidane-fetched");
    const last = await stat(fetched).catch(() => null);
    if (!existsSync(resolve(mirror, "HEAD"))) {
      const init = await run(git, ["init", "--bare", "-q", mirror], { env });
      if (init.code !== 0) throw new Error(`could not create the mirror: ${init.err.trim()}`);
    }
    if (!last || Date.now() - last.mtimeMs >= freshMs) {
      const fetch = await run(git, [
        "-C", mirror, "fetch", "--prune", "--quiet", "--no-write-fetch-head", url,
        "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*",
      ], { env });
      if (fetch.code !== 0) {
        if (!last) await rm(mirror, { recursive: true, force: true });
        throw new Error(`could not fetch into the mirror: ${withoutCredentials(fetch.err.trim())}`);
      }
      const head = await run(git, ["ls-remote", "--symref", url, "HEAD"], { env });
      const branch = /^ref:\s+(refs\/heads\/\S+)\s+HEAD/m.exec(head.out)?.[1];
      if (branch) await run(git, ["-C", mirror, "symbolic-ref", "HEAD", branch], { env });
      await touch(fetched);
    }
    await touch(resolve(mirror, "zidane-used"));
  });
}

/**
 * Carry out `git clone` through the mirror; resolves to the exit code.
 *
 * Falls back to the clone exactly as typed whenever the mirror cannot serve it, and
 * reports `cached` so a caller can say which it was.
 */
export async function cachedClone(args, {
  git, cache, cwd = process.cwd(), env = process.env, stdio = "inherit", signal,
  note = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  const plain = async (reason) => {
    if (reason) note(`${NOTE} cloning without the shared mirror (${reason})`);
    const result = await run(git, args, { cwd, env, stdio, signal });
    return { code: result.code, cached: false, out: result.out, err: result.err };
  };
  const plan = cache ? planClone(args) : null;
  if (!plan) return plain();
  let base = cwd;
  for (let at = 0; at < plan.global.length; at += 1) {
    if (plan.global[at] === "-C") base = resolve(base, plan.global[at + 1]);
  }
  const target = isAbsolute(plan.directory) ? plan.directory : resolve(base, plan.directory);
  // An existing, non-empty target is git's error to report, in git's words.
  if (existsSync(target) && (await readdir(target).catch(() => [])).length) return plain();
  const mirror = resolve(cache, plan.key);
  try {
    await refreshMirror(git, mirror, plan.url, { env });
  } catch (error) {
    return plain(withoutCredentials(error?.message ?? error));
  }
  const step = (extra) => run(git, [...plan.global, ...extra], { cwd, env, stdio, signal });
  // A question whose answer is read here: always captured, whatever `stdio` the caller
  // asked for — with the terminal's, the answer would print instead of returning.
  const ask = (extra) => run(git, [...plan.global, ...extra], { cwd, env, signal });
  const clone = await step(["clone", ...plan.options, "--no-checkout", "--", mirror, plan.directory]);
  if (clone.code !== 0) {
    await rm(target, { recursive: true, force: true });
    return plain("the clone from the mirror failed");
  }
  const inside = ["-C", plan.directory];
  await step([...inside, "remote", "set-url", "origin", plan.url]);
  // Then ask origin itself, with this URL's own credentials. It is what an ordinary
  // clone would have done: it proves this session can reach the repository — a mirror
  // filled through another URL must not hand out what this one cannot fetch — and it
  // brings in anything newer than the mirror. Usually a second's work.
  const verify = await ask([...inside, "fetch", "-q", "origin"]);
  if (verify.code !== 0) {
    await rm(target, { recursive: true, force: true });
    return plain("origin could not be fetched with this URL");
  }
  const branch = (await ask([...inside, "symbolic-ref", "-q", "HEAD"])).out.trim();
  if (branch.startsWith("refs/heads/")) {
    const tracking = `refs/remotes/origin/${branch.slice("refs/heads/".length)}`;
    if ((await ask([...inside, "rev-parse", "-q", "--verify", tracking])).code === 0) {
      await ask([...inside, "update-ref", branch, tracking]);
    }
  }
  if (plan.checkout) {
    // After `origin` is the real URL, so an LFS smudge or a relative submodule URL
    // resolves against the repository rather than the mirror.
    const checkout = await step([...inside, "reset", "--hard", "-q"]);
    if (checkout.code !== 0) return { code: checkout.code, cached: true, out: checkout.out, err: checkout.err };
    if (plan.submodules) {
      const modules = await step([...inside, "submodule", "update", "--init", "--recursive", "-q"]);
      if (modules.code !== 0) return { code: modules.code, cached: true, out: modules.out, err: modules.err };
    }
  }
  if (!plan.quiet) {
    note(`${NOTE} cloned from the shared mirror ~/.cache/zidane/repos/${plan.key}; origin is ${withoutCredentials(plan.url)}`);
  }
  return { code: 0, cached: true, out: clone.out, err: clone.err, directory: target };
}

/**
 * `checkout_repo`: a repository in this session's workspace, at the ref asked for.
 *
 * A clone the conversation already has is reused — fetched, then switched — so calling
 * it twice is cheap and never a second copy. A ref that is not a branch or tag the clone
 * knows (a commit, a pull-request ref) is fetched by name and checked out detached.
 */
export async function checkoutRepository(sandbox, { url, ref, directory } = {}, { signal } = {}) {
  const { sandboxEnvironment, withinWorkspace } = await import("./sandbox.mjs");
  const env = sandboxEnvironment(process.env, sandbox);
  const git = sandbox.git?.git ?? realGit(env.PATH);
  const fail = (message) => ({ message, details: { ok: false } });
  if (!git) return fail("git is not installed on this agent.");
  const source = String(url ?? "").trim();
  const name = String(directory ?? "").trim() || humanish(source);
  if (!source || !name) return fail("Give the repository URL, and a directory if its name cannot be worked out from the URL.");
  if (!withinWorkspace(sandbox.workspace, name)) return fail(`The directory must be inside this conversation's workspace (${sandbox.workspace}).`);
  const target = isAbsolute(name) ? resolve(name) : resolve(sandbox.workspace, name);
  const options = { cwd: sandbox.workspace, env, signal };
  const inside = (...args) => run(git, ["-C", target, ...args], options);
  const why = (result) => withoutCredentials(`${result.err}${result.out}`.trim()).slice(-2_000);
  let cached = false;
  let reused = false;
  if (existsSync(resolve(target, ".git"))) {
    const origin = await inside("remote", "get-url", "origin");
    if (mirrorKey(origin.out.trim()) !== mirrorKey(source) && origin.out.trim() !== source) {
      return fail(`${target} already holds a different repository (${withoutCredentials(origin.out.trim()) || "no origin"}). Name another directory.`);
    }
    const fetch = await inside("fetch", "-q", "--prune", "origin");
    if (fetch.code !== 0) return fail(`Could not fetch ${withoutCredentials(source)}: ${why(fetch)}`);
    reused = true;
  } else {
    const notes = [];
    const clone = await cachedClone(["clone", "-q", source, name], {
      git,
      cache: env.AI_AGENT_GIT_CACHE_DIR,
      cwd: sandbox.workspace,
      env,
      signal,
      stdio: ["ignore", "pipe", "pipe"],
      note: (line) => notes.push(line),
    });
    if (clone.code !== 0) return fail(`Could not clone ${withoutCredentials(source)}: ${why(clone) || notes.join(" ")}`);
    cached = clone.cached;
  }
  if (ref) {
    let switched = await inside("checkout", "-q", ref);
    if (switched.code !== 0) {
      const fetched = await inside("fetch", "-q", "origin", ref);
      switched = fetched.code === 0 ? await inside("checkout", "-q", "FETCH_HEAD") : fetched;
    }
    if (switched.code !== 0) return fail(`Cloned into ${target}, but could not check out ${ref}: ${why(switched)}`);
  } else if (reused) {
    // A reused clone on a branch is brought up to date; one detached on purpose is left be.
    const branch = (await inside("symbolic-ref", "-q", "--short", "HEAD")).out.trim();
    if (branch) await inside("merge", "-q", "--ff-only", `origin/${branch}`);
  }
  const head = (await inside("rev-parse", "HEAD")).out.trim();
  const branch = (await inside("symbolic-ref", "-q", "--short", "HEAD")).out.trim();
  const where = branch ? `branch ${branch}` : "a detached HEAD";
  return {
    message: `${reused ? "Updated the existing clone" : "Cloned"} ${withoutCredentials(source)} in ${target}, on ${where} at ${head.slice(0, 12)}.`
      + (cached ? " It came from the agent's shared mirror; origin is the real repository." : ""),
    details: { ok: true, directory: target, head, branch: branch || null, cached, reused },
  };
}

/**
 * Remove mirrors nobody has cloned from in `ttlMs`, and locks their holders abandoned.
 *
 * Safe at any time: a clone hard-links the objects it took, so it does not need the
 * mirror afterwards, and a mirror being updated right now holds its lock.
 */
export async function pruneMirrors(cache, { ttlMs = MIRROR_TTL_MS, now = Date.now() } = {}) {
  const removed = [];
  const walk = async (directory, depth) => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = resolve(directory, entry.name);
      if (entry.name.endsWith(".git.lock")) {
        const held = await stat(path).catch(() => null);
        if (held && now - held.mtimeMs > LOCK_STALE_MS) await rm(path, { recursive: true, force: true });
      } else if (entry.name.endsWith(".git") && existsSync(resolve(path, "HEAD"))) {
        if (existsSync(`${path}.lock`)) continue;
        const used = await stat(resolve(path, "zidane-used")).catch(() => stat(path));
        if (now - used.mtimeMs > ttlMs) {
          await rm(path, { recursive: true, force: true });
          removed.push(path);
        }
      } else if (depth < 8) {
        await walk(path, depth + 1);
      }
    }
  };
  await walk(cache, 0);
  return removed;
}

// `bin/git` runs this file for a clone: `node git-cache.mjs clone …`.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const git = process.env.AI_AGENT_GIT || realGit(process.env.PATH);
  if (!git) {
    process.stderr.write(`${NOTE} no git found on PATH\n`);
    process.exit(127);
  }
  const { code } = await cachedClone(process.argv.slice(2), { git, cache: process.env.AI_AGENT_GIT_CACHE_DIR });
  process.exit(code);
}
