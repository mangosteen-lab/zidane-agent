import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, test } from "node:test";
import { AgentDataStore, discoverSkills } from "../src/agent-data.mjs";
import { initialise, readSecretValue } from "../src/config.mjs";
import { ConnectorStore, ConnectorWatcher, expiryState, interpolate, isDue, redact, referencedValues, transitionOf } from "../src/connectors.mjs";

const TOUCHED = ["JIRA_SITE", "JIRA_EMAIL", "JIRA_TOKEN", "WIKI_SITE", "WIKI_TOKEN", "PROBE_TOKEN"];

after(() => { for (const key of TOUCHED) delete process.env[key]; });

async function workspace(prefix) {
  const root = await mkdtemp(resolve(tmpdir(), prefix));
  const local = await initialise({ name: "test", version: "1", description: "test", capacity: 1, workingDirectory: root });
  const data = new AgentDataStore(local, null, null, null);
  const connectors = new ConnectorStore(local, async () => data.configValueClaims());
  data.connectors = connectors;
  data.connectorValueClaims = () => connectors.valueClaims();
  return { root, local, data, connectors };
}

const SKILL = "---\nname: jira\ndescription: Work with Jira issues.\n---\n\nUse $JIRA_TOKEN.\n";

test("a connector is a skill and a config map in one folder", async () => {
  const { root, local, connectors } = await workspace("zidane-connector-test-");
  try {
    const created = (await connectors.handle("connector.create", {
      name: "jira",
      title: "Jira",
      description: "Issues.",
      content: SKILL,
      normal_values: { JIRA_SITE: "https://acme.atlassian.net", JIRA_EMAIL: "you@acme.com" },
      secret_values: ["JIRA_TOKEN"],
      secret_entries: { JIRA_TOKEN: "atl-secret-value" },
      verify: { http: { method: "GET", url: "${JIRA_SITE}/rest/api/3/myself", expect_status: 200 }, interval_minutes: 360 },
      expires: { at: "2099-01-01T00:00:00Z", warn_days: 7 },
    })).item;

    // The two files the design calls for, plus the identity sidecar every skill has.
    const directory = resolve(root, "connectors", "jira");
    const content = await readFile(resolve(directory, "SKILL.md"), "utf8");
    const record = JSON.parse(await readFile(resolve(directory, "config.json"), "utf8"));
    const sidecar = JSON.parse(await readFile(resolve(directory, ".zidane.json"), "utf8"));
    assert.match(content, /^---\nid: /);
    assert.equal(sidecar.id, created.id);
    assert.deepEqual(record.secret_values, ["JIRA_TOKEN"]);

    // The record carries the secret's name and never its value — the same rule a config
    // map follows, which is what lets a connector export to a branch by name only.
    assert.doesNotMatch(JSON.stringify(record), /atl-secret-value/);
    assert.doesNotMatch(JSON.stringify(created), /atl-secret-value/);
    assert.deepEqual(created.secret_values, [{ key: "JIRA_TOKEN", resolved: true }]);
    assert.equal(readSecretValue("JIRA_TOKEN"), "atl-secret-value");
    assert.equal(process.env.JIRA_SITE, "https://acme.atlassian.net");
    assert.equal((await stat(resolve(local.configMaps, ".env"))).mode & 0o777, 0o600);

    // And it is a skill: the same walk that finds `skills/` finds this, which is the
    // whole of the agent-side integration.
    const found = await discoverSkills(local.connectors);
    assert.equal(found.length, 1);
    assert.equal(found[0].name, "jira");
    assert.equal(found[0].identity, created.id);

    // Never checked is its own state, distinct from passing and from failing.
    assert.equal(created.status.state, "unconfigured");
    assert.equal(created.expiry.state, "ok");

    // Deleting takes the values off the environment; leaving them would let the next
    // skill that names one keep working against a connector nobody has.
    assert.equal((await connectors.handle("connector.delete", { connector_id: "jira" })).deleted, true);
    assert.equal(process.env.JIRA_SITE, undefined);
    assert.equal(process.env.JIRA_TOKEN, undefined);
    assert.doesNotMatch(await readFile(resolve(local.configMaps, ".env"), "utf8"), /JIRA_TOKEN/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one value name has one owner, in both directions", async () => {
  const { root, data, connectors } = await workspace("zidane-connector-claim-");
  try {
    await connectors.handle("connector.create", {
      name: "jira", content: SKILL,
      normal_values: { JIRA_SITE: "https://acme.atlassian.net" }, secret_values: ["JIRA_TOKEN"],
    });

    // A second connector may not take a name the first one owns. This is why Jira and
    // Confluence are separate connectors with namespaced values rather than one.
    await assert.rejects(
      connectors.handle("connector.create", {
        name: "confluence", content: SKILL, normal_values: {}, secret_values: ["JIRA_TOKEN"],
      }),
      /already provided by the jira connector/,
    );
    // Nor may a config map, which is the half the connector store cannot see itself.
    await assert.rejects(
      data.handle("config.create", { name: "wiki", normal_values: { JIRA_SITE: "https://other" }, secret_values: [] }),
      /already provided by the jira connector/,
    );
    // And the rule holds the other way round.
    await data.handle("config.create", { name: "wiki", normal_values: { WIKI_SITE: "https://wiki" }, secret_values: ["WIKI_TOKEN"] });
    await assert.rejects(
      connectors.handle("connector.create", {
        name: "confluence", content: SKILL, normal_values: {}, secret_values: ["WIKI_TOKEN"],
      }),
      /already provided by the wiki config map/,
    );
    // Namespacing is the way through, and it is not refused.
    const ok = (await connectors.handle("connector.create", {
      name: "confluence", content: SKILL,
      normal_values: { CONFLUENCE_SITE: "https://acme.atlassian.net" }, secret_values: ["CONFLUENCE_TOKEN"],
    })).item;
    assert.equal(ok.name, "confluence");

    // A connector cannot repoint the folder variables a skill uses to find agent state.
    await assert.rejects(
      connectors.handle("connector.create", { name: "bad", content: SKILL, normal_values: { AI_AGENT_KNOWLEDGE_FOLDER: "/tmp" } }),
      /reserved value name/,
    );
  } finally {
    for (const key of ["CONFLUENCE_SITE", "CONFLUENCE_TOKEN"]) delete process.env[key];
    await rm(root, { recursive: true, force: true });
  }
});

test("verify reports pass, fail and unconfigured, and never leaks the credential", async () => {
  const server = createServer((request, response) => {
    if (request.headers.authorization === "Bearer probe-secret-value") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"displayName":"Ada"}');
      return;
    }
    // A real proxy sometimes hands the credential back in its error body. This one does.
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "bad token", authorization: request.headers.authorization ?? "" }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { root, connectors } = await workspace("zidane-connector-verify-");
  try {
    const verify = {
      http: { method: "GET", url: "${PROBE_BASE}/me", auth: { type: "bearer", token: "${PROBE_TOKEN}" }, expect_status: 200 },
      interval_minutes: 60,
    };
    await connectors.handle("connector.create", {
      name: "probe", content: SKILL,
      normal_values: { PROBE_BASE: base }, secret_values: ["PROBE_TOKEN"], verify,
    });

    // A probe that names a value nothing supplies is not a failure to chase.
    const unset = (await connectors.handle("connector.verify", { connector_id: "probe" })).item;
    assert.equal(unset.status.state, "unconfigured");
    assert.match(unset.status.detail, /no value for PROBE_TOKEN/);

    // A wrong credential fails, and the echoed token does not survive into the status.
    await connectors.handle("connector.update", {
      connector_id: "probe", content: SKILL,
      normal_values: { PROBE_BASE: base }, secret_values: ["PROBE_TOKEN"],
      secret_entries: { PROBE_TOKEN: "wrong-token-value" }, verify,
    });
    const failed = (await connectors.handle("connector.verify", { connector_id: "probe" })).item;
    assert.equal(failed.status.state, "fail");
    assert.equal(failed.status.status_code, 401);
    assert.doesNotMatch(JSON.stringify(failed), /wrong-token-value/);

    // A good one passes, and the transition away from failing is marked.
    await connectors.handle("connector.update", {
      connector_id: "probe", content: SKILL,
      normal_values: { PROBE_BASE: base }, secret_values: ["PROBE_TOKEN"],
      secret_entries: { PROBE_TOKEN: "probe-secret-value" }, verify,
    });
    const passed = (await connectors.handle("connector.verify", { connector_id: "probe" })).item;
    assert.equal(passed.status.state, "pass");
    assert.equal(passed.status.changed, true);

    // The result is kept, so a console can show it without running the probe again.
    const stored = JSON.parse(await readFile(resolve(root, "connectors", "probe", "status.json"), "utf8"));
    assert.equal(stored.state, "pass");
    // The throwaway verify workspace does not outlive the check.
    await assert.rejects(stat(resolve(root, "workspaces", ".verify-probe")), { code: "ENOENT" });
  } finally {
    delete process.env.PROBE_BASE;
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a shell probe is the escape hatch for a credential with no endpoint", async () => {
  const { root, connectors } = await workspace("zidane-connector-shell-");
  try {
    await connectors.handle("connector.create", {
      name: "cli", content: SKILL, normal_values: { CLI_MARKER: "ready" }, secret_values: [],
      verify: { shell: { command: 'test "$CLI_MARKER" = ready && echo authenticated' } },
    });
    const passed = (await connectors.handle("connector.verify", { connector_id: "cli" })).item;
    assert.equal(passed.status.state, "pass");
    assert.match(passed.status.detail, /authenticated/);
    assert.equal(passed.verify.kind, "shell");

    await connectors.handle("connector.update", {
      connector_id: "cli", content: SKILL, normal_values: { CLI_MARKER: "ready" }, secret_values: [],
      verify: { shell: { command: "exit 3" } },
    });
    assert.equal((await connectors.handle("connector.verify", { connector_id: "cli" })).item.status.state, "fail");
  } finally {
    delete process.env.CLI_MARKER;
    await rm(root, { recursive: true, force: true });
  }
});

test("interpolation, redaction and expiry are decided without asking a model", () => {
  assert.deepEqual(interpolate("${A}/x", { A: "https://h" }), { text: "https://h/x", missing: [] });
  assert.deepEqual(interpolate("${A}${B}", { A: "" }), { text: "", missing: ["A", "B"] });
  assert.deepEqual(referencedValues({ http: { url: "${S}/p", auth: { token: "${T}" } } }), ["S", "T"]);

  assert.equal(redact("token=abcdefgh here", []), "token=[redacted] here");
  assert.equal(redact("value is supersecretvalue", ["supersecretvalue"]), "value is [redacted]");
  assert.equal(redact("Authorization: Bearer abcdefghijkl", []), "Authorization: [redacted]");
  // Too short to redact by value without turning the whole string into markers.
  assert.equal(redact("ab cd", ["ab"]), "ab cd");

  assert.equal(expiryState({ at: "2099-01-01T00:00:00Z" }).state, "ok");
  assert.equal(expiryState({ at: "2000-01-01T00:00:00Z" }).state, "expired");
  assert.equal(expiryState(null).state, "unknown");
  const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
  assert.equal(expiryState({ at: soon, warn_days: 7 }).state, "warn");
});

test("the watcher reports edges only, and never an unfinished connector", async () => {
  const server = createServer((request, response) => {
    response.writeHead(healthy ? 200 : 503).end(healthy ? "ok" : "down");
  });
  let healthy = true;
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { root, connectors } = await workspace("zidane-connector-watch-");
  try {
    const emitted = [];
    const watcher = new ConnectorWatcher(connectors, (type, body) => emitted.push({ type, body }), null, { perTick: 5 });
    const verify = { http: { url: "${WATCH_BASE}/health", expect_status: 200 }, interval_minutes: 60 };
    await connectors.handle("connector.create", {
      name: "watched", title: "Watched", content: SKILL,
      normal_values: { WATCH_BASE: base }, secret_values: [], verify,
    });
    // A connector whose probe names a value nothing supplies is never reported: nobody
    // finished adding it, and that is not an incident.
    await connectors.handle("connector.create", {
      name: "halfdone", content: SKILL, normal_values: {}, secret_values: ["MISSING_TOKEN"],
      verify: { http: { url: "${MISSING_BASE}/health" }, interval_minutes: 60 },
    });

    // First sweep: one passes, one is unconfigured. Neither is an edge.
    assert.deepEqual(await watcher.tick(), []);
    assert.equal(emitted.length, 0);

    // Not due again yet, so a second tick does nothing at all.
    assert.deepEqual(await watcher.tick(), []);

    // It breaks. The next due sweep reports exactly one transition.
    healthy = false;
    const later = Date.now() + 61 * 60_000;
    assert.deepEqual(await watcher.tick(later), [{ connector: "watched", transition: "failed" }]);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].type, "CONNECTOR_STATUS");
    assert.equal(emitted[0].body.connector, "watched");
    assert.equal(emitted[0].body.transition, "failed");
    assert.equal(emitted[0].body.previous_state, "pass");

    // Still broken is not news — a card every six hours trains people to ignore them.
    assert.deepEqual(await watcher.tick(later + 61 * 60_000), []);
    assert.equal(emitted.length, 1);

    // Recovery is its own edge, so the rail stops showing a problem that is fixed.
    healthy = true;
    const fixed = later + 122 * 60_000;
    assert.deepEqual(await watcher.tick(fixed), [{ connector: "watched", transition: "recovered" }]);
    assert.equal(emitted.at(-1).body.transition, "recovered");

    // The half-finished one never said anything, through all of it.
    assert.equal(emitted.filter((item) => item.body.connector === "halfdone").length, 0);
  } finally {
    delete process.env.WATCH_BASE;
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a connector with no health check is never due", () => {
  assert.equal(isDue({ verify: null }), false);
  assert.equal(isDue({ verify: { http: { url: "x" }, interval_minutes: 60 }, status: null }), true);
  const now = Date.now();
  const fresh = { verify: { http: { url: "x" }, interval_minutes: 60 }, status: { checked_at: new Date(now).toISOString() } };
  assert.equal(isDue(fresh, now), false);
  assert.equal(isDue(fresh, now + 61 * 60_000), true);

  assert.equal(transitionOf("pass", "fail"), "failed");
  assert.equal(transitionOf(null, "fail"), "failed");
  assert.equal(transitionOf("fail", "fail"), null);
  assert.equal(transitionOf("fail", "pass"), "recovered");
  assert.equal(transitionOf(null, "pass"), null);
  // Nobody is paged because a connector was never finished, in either direction.
  assert.equal(transitionOf("unconfigured", "unconfigured"), null);
  assert.equal(transitionOf("pass", "unconfigured"), null);
});

test("an account connector syncs down, renames in place, and leaves local ones alone", async () => {
  const { root, connectors } = await workspace("zidane-connector-sync-");
  try {
    // One the agent made for itself. A sync must never sweep this.
    await connectors.handle("connector.create", {
      name: "local", content: SKILL, normal_values: { LOCAL_BASE: "https://local" }, secret_values: [],
    });

    const shared = (id, name, value) => ({
      source_id: id,
      name,
      content: `---\nid: ${id}\nname: ${name}\ndescription: Shared.\n---\n# ${name}\n`,
      title: name, description: "",
      normal_values: { SHARED_SITE: value }, secret_values: ["SHARED_TOKEN"],
      secret_entries: { SHARED_TOKEN: "shared-secret-value" },
      verify: { http: { url: "${SHARED_SITE}/me" }, interval_minutes: 60 },
    });

    assert.deepEqual(
      await connectors.refreshAccount([shared("acct-1", "shared", "https://one")]),
      { created: 1, updated: 0, removed: 0 },
    );
    const copy = (await connectors.handle("connector.get", { connector_id: "shared" })).item;
    // The account's row id travels in the file, so the copy *is* that row's connector.
    assert.equal(copy.id, "acct-1");
    assert.equal(process.env.SHARED_SITE, "https://one");
    assert.equal(readSecretValue("SHARED_TOKEN"), "shared-secret-value");

    // Renaming on the account renames the copy rather than leaving a second one.
    assert.deepEqual(
      await connectors.refreshAccount([shared("acct-1", "renamed", "https://two")]),
      { created: 0, updated: 1, removed: 0 },
    );
    const names = (await connectors.list()).map((item) => item.name).sort();
    assert.deepEqual(names, ["local", "renamed"]);
    assert.equal(process.env.SHARED_SITE, "https://two");

    // Revoking visibility takes the credential off the disk; the local one survives.
    assert.deepEqual(await connectors.refreshAccount([]), { created: 0, updated: 0, removed: 1 });
    assert.deepEqual((await connectors.list()).map((item) => item.name), ["local"]);
    assert.equal(process.env.SHARED_TOKEN, undefined);
    assert.equal(process.env.LOCAL_BASE, "https://local");
  } finally {
    for (const key of ["LOCAL_BASE", "SHARED_SITE", "SHARED_TOKEN"]) delete process.env[key];
    await rm(root, { recursive: true, force: true });
  }
});

test("a connector can be renamed without colliding with its own outgoing copy", async () => {
  const { root, connectors } = await workspace("zidane-connector-rename-");
  try {
    await connectors.handle("connector.create", {
      name: "before", content: SKILL,
      normal_values: { RENAME_SITE: "https://x" }, secret_values: ["RENAME_TOKEN"],
    });
    const renamed = (await connectors.handle("connector.update", {
      connector_id: "before", name: "after", content: SKILL,
      normal_values: { RENAME_SITE: "https://x" }, secret_values: ["RENAME_TOKEN"],
    })).item;
    assert.equal(renamed.name, "after");
    assert.deepEqual((await connectors.list()).map((item) => item.name), ["after"]);
  } finally {
    for (const key of ["RENAME_SITE", "RENAME_TOKEN"]) delete process.env[key];
    await rm(root, { recursive: true, force: true });
  }
});
