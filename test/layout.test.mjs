import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { AgentDataStore } from "../src/agent-data.mjs";
import { applyState, initialise, readSecretValue, readSessionToken } from "../src/config.mjs";

test("a config map declares secret value names; the values come from the environment", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zidane-configmap-test-"));
  try {
    const config = { name: "test", version: "1", description: "test", capacity: 1, workingDirectory: root };
    const local = await initialise(config);
    assert.equal(process.env.AI_AGENT_CONFIG_MAPS_FOLDER, resolve(root, "config-maps"));
    // There is no separate secret store any more.
    assert.equal(local.secrets, undefined);
    await assert.rejects(stat(resolve(root, "secrets")), { code: "ENOENT" });

    const store = new AgentDataStore(local);
    const created = (await store.handle("config.create", {
      name: "confluence",
      title: "Confluence",
      description: "Team knowledge base.",
      normal_values: { CONFLUENCE_URL: "https://example.atlassian.net" },
      secret_values: ["CONFLUENCE_TOKEN"],
    })).item;

    // One JSON record per map, in exactly the documented shape.
    const record = JSON.parse(await readFile(resolve(root, "config-maps", "confluence.json"), "utf8"));
    assert.equal(record.title, "Confluence");
    assert.deepEqual(record.normal_values, { CONFLUENCE_URL: "https://example.atlassian.net" });
    assert.deepEqual(record.secret_values, ["CONFLUENCE_TOKEN"]);
    // A declared name with no value yet is reported unresolved, never invented.
    assert.deepEqual(created.secret_values, [{ key: "CONFLUENCE_TOKEN", resolved: false }]);
    assert.equal(process.env.CONFLUENCE_URL, "https://example.atlassian.net");

    // Supplying a value writes it to .env and puts it in the environment.
    await store.handle("config.update", {
      config_id: "confluence",
      name: "confluence",
      title: "Confluence",
      normal_values: { CONFLUENCE_URL: "https://example.atlassian.net" },
      secret_entries: { CONFLUENCE_TOKEN: "atl-secret" },
    });
    assert.equal(readSecretValue("CONFLUENCE_TOKEN"), "atl-secret");
    const envFile = await readFile(resolve(root, "config-maps", ".env"), "utf8");
    assert.match(envFile, /CONFLUENCE_TOKEN=/);
    assert.equal((await stat(resolve(root, "config-maps", ".env"))).mode & 0o777, 0o600);
    // The record still carries only the name.
    const updated = JSON.parse(await readFile(resolve(root, "config-maps", "confluence.json"), "utf8"));
    assert.doesNotMatch(JSON.stringify(updated), /atl-secret/);
    assert.doesNotMatch(JSON.stringify(await store.handle("config.list")), /atl-secret/);

    // An environment variable set by the deployment wins over the file.
    process.env.DEPLOY_TOKEN = "from-deployment";
    await store.handle("config.create", {
      name: "deploy", title: "Deploy", normal_values: {}, secret_values: ["DEPLOY_TOKEN"],
    });
    assert.equal(readSecretValue("DEPLOY_TOKEN"), "from-deployment");
    assert.equal((await store.handle("config.get", { config_id: "deploy" })).item.secret_values[0].resolved, true);

    // Reserved prefixes cannot be declared or supplied.
    await assert.rejects(
      store.handle("config.create", { name: "bad", normal_values: {}, secret_values: ["ZIDANE_AGENT_API_KEY"] }),
      /reserved secret value name/,
    );
    await assert.rejects(
      store.handle("config.create", { name: "bad2", normal_values: {}, secret_entries: { AI_AGENT_CONFIG_MAPS_FOLDER: "/tmp" } }),
      /reserved secret value name/,
    );

    // A desired-state push writes secret values the same way.
    await applyState(local, "revision-1", { LOG_LEVEL: "debug" }, { PUSHED_TOKEN: "pushed" });
    assert.equal(readSecretValue("PUSHED_TOKEN"), "pushed");
    assert.match(await readFile(resolve(root, "config-maps", ".env"), "utf8"), /PUSHED_TOKEN=/);
    // Dropping it from the next revision removes it again.
    await applyState(local, "revision-2", { LOG_LEVEL: "debug" }, {});
    assert.doesNotMatch(await readFile(resolve(root, "config-maps", ".env"), "utf8"), /PUSHED_TOKEN=/);
    assert.throws(() => readSecretValue("PUSHED_TOKEN"), /no value for PUSHED_TOKEN/);

    assert.equal((await store.handle("config.delete", { config_id: "confluence" })).deleted, true);
    assert.equal(process.env.CONFLUENCE_URL, undefined);
  } finally {
    for (const key of ["CONFLUENCE_URL", "CONFLUENCE_TOKEN", "DEPLOY_TOKEN", "PUSHED_TOKEN", "LOG_LEVEL"]) delete process.env[key];
    await rm(root, { recursive: true, force: true });
  }
});

test("the old secret store is retired and the agent's own credentials keep working", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zidane-retire-test-"));
  try {
    await mkdir(resolve(root, "secrets", "synced", "GITHUB"), { recursive: true });
    await writeFile(resolve(root, "secrets", "synced", "GITHUB", "token"), "gh-token");
    await writeFile(resolve(root, "secrets", "session-token"), "rotating-session");
    await writeFile(resolve(root, "secrets", "pi-auth.json"), '{"openai":{}}');
    await writeFile(resolve(root, "secrets", "knowledge-source-1"), "kb-credential");

    const local = await initialise({ name: "test", version: "1", description: "", capacity: 1, workingDirectory: root });

    // The agent's own credentials survive in auth/; the secret store does not.
    assert.equal(await readSessionToken(local), "rotating-session");
    assert.equal(await readFile(resolve(root, "auth", "pi-auth.json"), "utf8"), '{"openai":{}}');
    assert.equal(await readFile(resolve(root, "auth", "knowledge-source-1"), "utf8"), "kb-credential");
    await assert.rejects(stat(resolve(root, "secrets")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
