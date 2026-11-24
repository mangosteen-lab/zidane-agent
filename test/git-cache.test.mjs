import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  checkoutRepository, gitCacheSettings, humanish, mirrorKey, mirrorRoot, planClone, pruneMirrors,
  WRAPPER_DIR, withLock, withoutCredentials,
} from "../src/git-cache.mjs";
import { prepareSandbox, sandboxEnvironment } from "../src/sandbox.mjs";

test("the remote URLs people actually use map to one mirror per repository", () => {
  const cases = [
    ["ssh://git@tec-l-1203160.labs.microstrategy.com:22222/qhu/IServerDev.git", "tec-l-1203160.labs.microstrategy.com/qhu/iserverdev.git", "IServerDev"],
    ["http://tec-l-1203160.labs.microstrategy.com/qhu/IServerDev.git", "tec-l-1203160.labs.microstrategy.com/qhu/iserverdev.git", "IServerDev"],
    ["https://tec-l-1203160.labs.microstrategy.com/qhu/IServerDev", "tec-l-1203160.labs.microstrategy.com/qhu/iserverdev.git", "IServerDev"],
    ["git@github.com:mstr-kiai/history-list-migrator.git", "github.com/mstr-kiai/history-list-migrator.git", "history-list-migrator"],
    ["https://github.com/mstr-kiai/history-list-migrator.git/", "github.com/mstr-kiai/history-list-migrator.git", "history-list-migrator"],
    ["https://x-access-token:secret@gitlab.example.com/group/sub/Project.git", "gitlab.example.com/group/sub/project.git", "Project"],
    ["git://example.com/a/b.git", "example.com/a/b.git", "b"],
  ];
  for (const [url, key, directory] of cases) {
    assert.equal(mirrorKey(url), key, url);
    // The folder is git's own choice of name, case kept — not the mirror's.
    assert.equal(humanish(url), directory, url);
    const plan = planClone(["clone", url]);
    assert.equal(plan.key, key, url);
    assert.equal(plan.directory, directory, url);
  }
  // Credentials never reach the key, the path, or anything shown.
  assert.doesNotMatch(mirrorKey("https://user:secret@github.com/a/b.git"), /secret/);
  assert.equal(withoutCredentials("https://user:secret@github.com/a/b.git"), "https://***@github.com/a/b.git");
  assert.equal(withoutCredentials("https://ghp_token@github.com/a/b.git"), "https://***@github.com/a/b.git");
  assert.equal(withoutCredentials("ssh://git@host:22222/a/b.git"), "ssh://git@host:22222/a/b.git");

  // Already on disk, or not a URL git fetches over: nothing to share.
  for (const url of ["/srv/repo.git", "../repo", "file:///srv/repo.git", "C:repo", "host:path"]) {
    assert.equal(planClone(["clone", url]), null, url);
  }
  // A path that would escape the cache is not a mirror key. A URL's dot segments are
  // resolved by the URL itself, which keeps them under the host; the scp form is refused.
  assert.equal(mirrorKey("https://github.com/../../etc/passwd"), "github.com/etc/passwd.git");
  assert.equal(mirrorKey("git@github.com:a/../../b.git"), null);
});

test("only an ordinary clone is redirected; everything else reaches git as typed", () => {
  const url = "git@github.com:org/big-repo.git";
  for (const args of [
    ["clone", "--depth", "1", url],
    ["clone", "--depth=1", url],
    ["clone", "--bare", url],
    ["clone", "--mirror", url],
    ["clone", "--reference", "/x", url],
    ["clone", "--filter=blob:none", url],
    ["clone", "-o", "upstream", url],
    ["clone", "-qn", url],
    ["clone", url, "dir", "extra"],
    ["status"],
    ["fetch", "origin"],
    ["-C", "/w", "log"],
  ]) {
    assert.equal(planClone(args), null, args.join(" "));
  }
  const plan = planClone(["-C", "/w", "-c", "core.x=1", "clone", "-q", "-b", "dev", "--recurse-submodules", url, "work"]);
  assert.deepEqual(plan.global, ["-C", "/w", "-c", "core.x=1"]);
  assert.deepEqual(plan.options, ["-q", "-b", "dev", "--recurse-submodules"]);
  assert.equal(plan.directory, "work");
  assert.equal(plan.quiet, true);
  assert.equal(plan.submodules, true);
  assert.equal(planClone(["clone", "--no-checkout", url]).checkout, false);
});

test("a held lock makes the next holder wait, and a dead holder's lock is broken", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zidane-git-lock-test-"));
  try {
    const lock = resolve(root, "repo.git.lock");
    const order = [];
    await Promise.all([
      withLock(lock, async () => { order.push("a+"); await new Promise((done) => setTimeout(done, 300)); order.push("a-"); }),
      new Promise((done) => setTimeout(done, 50)).then(() => withLock(lock, async () => { order.push("b+"); order.push("b-"); })),
    ]);
    assert.deepEqual(order, ["a+", "a-", "b+", "b-"]);

    await mkdir(lock);
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(lock, old, old);
    assert.equal(await withLock(lock, async () => "taken"), "taken");
    assert.equal(existsSync(lock), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** A repository served over (dumb) HTTP from a temporary directory: a real remote. */
async function servedRepository(root) {
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=trunk", ...args], { cwd, stdio: "pipe" }).toString();
  const source = resolve(root, "source");
  await mkdir(source, { recursive: true });
  git(source, "init", "-q");
  await writeFile(resolve(source, "README.md"), "trunk\n");
  git(source, "add", ".");
  git(source, "commit", "-qm", "first");
  git(source, "tag", "v1");
  git(source, "checkout", "-qb", "dev");
  await writeFile(resolve(source, "DEV.md"), "dev\n");
  git(source, "add", ".");
  git(source, "commit", "-qm", "dev work");
  git(source, "checkout", "-q", "trunk");
  const served = resolve(root, "served");
  await mkdir(served);
  git(root, "clone", "-q", "--bare", source, resolve(served, "Big-Repo.git"));
  git(resolve(served, "Big-Repo.git"), "update-server-info");
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests += 1;
    const path = resolve(served, `.${decodeURIComponent(new URL(request.url, "http://x").pathname)}`);
    if (!path.startsWith(served)) { response.writeHead(403).end(); return; }
    try {
      response.writeHead(200).end(await readFile(path));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${server.address().port}/Big-Repo.git`;
  return {
    url,
    get requests() { return requests; },
    commit: (file, content) => {
      execFileSync("sh", ["-c", `printf '%s' "$2" > "$1"`, "sh", resolve(source, file), content]);
      git(source, "add", ".");
      git(source, "commit", "-qm", `add ${file}`);
      git(source, "push", "-q", resolve(served, "Big-Repo.git"), "trunk");
      git(resolve(served, "Big-Repo.git"), "update-server-info");
    },
    close: () => new Promise((done) => server.close(done)),
  };
}

function wrapped(args, { cwd, env }) {
  return new Promise((settle) => {
    const child = spawn(resolve(WRAPPER_DIR, "git"), args, { cwd, env });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("close", (code) => settle({ code, out, err }));
  });
}

test("git clone through the wrapper downloads once, and every clone is its own", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zidane-git-cache-test-"));
  const remote = await servedRepository(root);
  try {
    const settings = gitCacheSettings({ PATH: process.env.PATH });
    assert.ok(settings, "a real git and the wrapper are present");
    const home = resolve(root, "home");
    const first = await prepareSandbox(resolve(root, "workspaces", "one"), home, settings);
    const second = await prepareSandbox(resolve(root, "workspaces", "two"), home, settings);
    const envOf = (paths) => sandboxEnvironment(process.env, paths);
    // The wrapper is what a session finds first, and plain git commands pass straight through.
    assert.equal(envOf(first).PATH.split(":")[0], WRAPPER_DIR);
    assert.match((await wrapped(["--version"], { cwd: first.workspace, env: envOf(first) })).out, /^git version/);

    // The literal command a person types.
    const cloned = await wrapped(["clone", remote.url], { cwd: first.workspace, env: envOf(first) });
    assert.equal(cloned.code, 0, cloned.err);
    assert.match(cloned.err, /cloned from the shared mirror ~\/\.cache\/zidane\/repos\/127\.0\.0\.1\/big-repo\.git/);
    const clone = resolve(first.workspace, "Big-Repo");
    assert.equal(await readFile(resolve(clone, "README.md"), "utf8"), "trunk\n");
    // Indistinguishable from an ordinary clone: origin is the real URL, the remote's
    // default branch is checked out, and the other branches are there to switch to.
    const inFirst = (...args) => execFileSync("git", ["-C", clone, ...args]).toString().trim();
    assert.equal(inFirst("remote", "get-url", "origin"), remote.url);
    assert.equal(inFirst("branch", "--show-current"), "trunk");
    assert.match(inFirst("branch", "-r"), /origin\/dev/);
    assert.equal(inFirst("status", "--porcelain"), "");
    const mirror = resolve(mirrorRoot(home), "127.0.0.1", "big-repo.git");
    assert.ok(existsSync(resolve(mirror, "HEAD")));

    // A second session, moments later: the mirror is fresh, so nothing is fetched into it
    // — the only network traffic is the clone checking origin for anything newer.
    const before = remote.requests;
    const again = await wrapped(["clone", "-b", "dev", remote.url, "work"], { cwd: second.workspace, env: envOf(second) });
    assert.equal(again.code, 0, again.err);
    assert.equal(await readFile(resolve(second.workspace, "work", "DEV.md"), "utf8"), "dev\n");
    assert.ok(remote.requests - before < 10, `the second clone made ${remote.requests - before} requests`);

    // The mirror is fresh, so it is not fetched again — but a commit made since still
    // arrives, because every clone asks origin for what is newer than the mirror.
    remote.commit("LATEST.md", "latest\n");
    const third = await prepareSandbox(resolve(root, "workspaces", "three"), home, settings);
    const latest = await wrapped(["clone", "-q", remote.url], { cwd: third.workspace, env: envOf(third) });
    assert.equal(latest.code, 0, latest.err);
    assert.equal(await readFile(resolve(third.workspace, "Big-Repo", "LATEST.md"), "utf8"), "latest\n");

    // A URL this session cannot reach does not get a clone out of the mirror another URL
    // filled: same repository key, but origin refuses, so it fails the way git does.
    const unreachable = remote.url.replace(/:\d+\//, ":1/");
    const refused = await wrapped(["clone", "-q", unreachable, "denied"], { cwd: third.workspace, env: envOf(third) });
    assert.notEqual(refused.code, 0);
    assert.equal(existsSync(resolve(third.workspace, "denied")), false);

    // Separate working files: what one session writes, the other never sees.
    await writeFile(resolve(clone, "README.md"), "edited in one\n");
    assert.equal(await readFile(resolve(second.workspace, "work", "README.md"), "utf8"), "trunk\n");

    // An existing, non-empty target is git's own error.
    const clash = await wrapped(["clone", remote.url], { cwd: first.workspace, env: envOf(first) });
    assert.notEqual(clash.code, 0);
    assert.match(clash.err, /already exists/);

    // Independent: with the mirror gone, both clones are complete repositories.
    await rm(mirror, { recursive: true, force: true });
    execFileSync("git", ["-C", clone, "fsck", "--no-progress"], { stdio: "pipe" });
    execFileSync("git", ["-C", resolve(second.workspace, "work"), "log", "--oneline", "origin/trunk"], { stdio: "pipe" });

    // Off with the switch: no wrapper at all.
    assert.equal(gitCacheSettings({ PATH: process.env.PATH, ZIDANE_AGENT_GIT_CACHE: "false" }), null);
    assert.equal(sandboxEnvironment({ PATH: "/usr/bin" }, { ...first, git: null }).PATH.includes(WRAPPER_DIR), false);
  } finally {
    await remote.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("two sessions cloning at once share one download and each get their own clone", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zidane-git-race-test-"));
  const remote = await servedRepository(root);
  try {
    const settings = gitCacheSettings({ PATH: process.env.PATH });
    const home = resolve(root, "home");
    const sessions = await Promise.all(["a", "b", "c"].map((name) => prepareSandbox(resolve(root, "workspaces", name), home, settings)));
    const results = await Promise.all(sessions.map((paths) => wrapped(["clone", "-q", remote.url], {
      cwd: paths.workspace, env: sandboxEnvironment(process.env, paths),
    })));
    for (const result of results) assert.equal(result.code, 0, result.err);
    for (const paths of sessions) {
      assert.equal(await readFile(resolve(paths.workspace, "Big-Repo", "README.md"), "utf8"), "trunk\n");
    }
    assert.equal(existsSync(`${resolve(mirrorRoot(home), "127.0.0.1", "big-repo.git")}.lock`), false);
  } finally {
    await remote.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("checkout_repo clones, switches refs, and reuses its clone", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zidane-checkout-test-"));
  const remote = await servedRepository(root);
  try {
    const sandbox = await prepareSandbox(resolve(root, "workspaces", "one"), resolve(root, "home"), gitCacheSettings({ PATH: process.env.PATH }));
    const first = await checkoutRepository(sandbox, { url: remote.url, ref: "v1" });
    assert.equal(first.details.ok, true, first.message);
    assert.equal(first.details.cached, true);
    assert.equal(first.details.branch, null);
    assert.equal(first.details.directory, resolve(sandbox.workspace, "Big-Repo"));
    assert.match(first.message, /detached HEAD/);

    // Again, for a branch only the remote has: the same clone, switched and tracking.
    const second = await checkoutRepository(sandbox, { url: remote.url, ref: "dev" });
    assert.equal(second.details.ok, true, second.message);
    assert.equal(second.details.reused, true);
    assert.equal(second.details.branch, "dev");
    assert.ok(existsSync(resolve(sandbox.workspace, "Big-Repo", "DEV.md")));

    // Called once more with no ref after the remote moved: the branch is brought up to date.
    await checkoutRepository(sandbox, { url: remote.url, ref: "trunk" });
    remote.commit("NEW.md", "new\n");
    const third = await checkoutRepository(sandbox, { url: remote.url });
    assert.equal(third.details.ok, true, third.message);
    assert.ok(existsSync(resolve(sandbox.workspace, "Big-Repo", "NEW.md")));

    // Confined to the workspace, and never on top of a different repository.
    const outside = await checkoutRepository(sandbox, { url: remote.url, directory: "/etc/elsewhere" });
    assert.equal(outside.details.ok, false);
    const other = await checkoutRepository(sandbox, { url: "https://github.com/someone/else.git", directory: "Big-Repo" });
    assert.equal(other.details.ok, false);
    assert.match(other.message, /different repository/);
  } finally {
    await remote.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("mirrors nobody uses are pruned, and a clone outlives its mirror", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zidane-prune-test-"));
  try {
    const cache = resolve(root, "repos");
    const make = async (key, ageDays) => {
      const mirror = join(cache, key);
      await mkdir(mirror, { recursive: true });
      await writeFile(resolve(mirror, "HEAD"), "ref: refs/heads/main\n");
      await writeFile(resolve(mirror, "zidane-used"), "");
      const at = new Date(Date.now() - ageDays * 24 * 60 * 60_000);
      await utimes(resolve(mirror, "zidane-used"), at, at);
      return mirror;
    };
    const stale = await make("github.com/org/old.git", 20);
    const recent = await make("github.com/org/new.git", 1);
    const busy = await make("gitlab.example.com/group/sub/busy.git", 30);
    await mkdir(`${busy}.lock`);
    const removed = await pruneMirrors(cache);
    assert.deepEqual(removed, [stale]);
    assert.ok(existsSync(recent));
    // Being updated right now: left alone whatever its age.
    assert.ok((await stat(busy)).isDirectory());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
