import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { AgentDataStore } from "../src/agent-data.mjs";
import { initialise } from "../src/config.mjs";

test("agent-owned skills, config maps, and secrets support local CRUD and account imports", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zidane-agent-data-test-"));
  const environmentKey = "AGENT_DATA_TEST_SETTING";
  try {
    const local = await initialise({ name: "test", version: "1", description: "", capacity: 1, workingDirectory: root });
    const store = new AgentDataStore(local);

    const manualDirectory = resolve(local.skills, "manual-skill");
    await mkdir(manualDirectory, { recursive: true });
    await writeFile(resolve(manualDirectory, "SKILL.md"), "---\nname: manual-skill\ndescription: Existing skill\n---\n\n# Manual\n");
    const initialSkills = await store.handle("skill.list");
    assert.equal(initialSkills.items[0].name, "manual-skill");
    assert.equal("content" in initialSkills.items[0], false);

    const createdSkill = (await store.handle("skill.create", {
      name: "Deploy safely",
      content: "---\nname: deploy-safely\ndescription: Safe deployment checks\n---\n\n# Deploy safely\n",
    })).item;
    assert.equal((await store.handle("skill.list")).items.length, 2);
    assert.match((await store.handle("skill.get", { skill_id: createdSkill.skill_id })).item.content, /Deploy safely/);
    const updatedSkill = (await store.handle("skill.update", {
      skill_id: createdSkill.skill_id,
      name: "Deploy with checks",
      content: "---\nname: deploy-with-checks\ndescription: Safe deployment checks\n---\n\n# Deploy with checks\n",
    })).item;
    assert.equal(updatedSkill.name, "Deploy with checks");
    assert.equal((await store.handle("skill.delete", { skill_id: createdSkill.skill_id })).deleted, true);

    const importedSkills = (await store.handle("skill.import", {
      items: [{ source_id: "account-skill-1", name: "Incident response", content: "# Incident response\n" }],
    })).items;
    assert.equal(importedSkills[0].source.scope, "account");
    assert.equal(importedSkills[0].source.id, "account-skill-1");
    // Re-importing the same account skill updates the copy in place.
    const reimported = (await store.handle("skill.import", {
      items: [{ source_id: "account-skill-1", name: "Incident response", content: "# Incident response v2\n" }],
    })).items;
    assert.equal(reimported[0].skill_id, importedSkills[0].skill_id);
    assert.equal((await store.handle("skill.list")).items.filter((item) => item.source.scope === "account").length, 1);
    assert.match((await store.handle("skill.get", { skill_id: reimported[0].skill_id })).item.content, /v2/);

    const localConfig = (await store.handle("config.create", {
      name: "Local runtime",
      values: { [environmentKey]: "local", "setting.with.dots": "stored" },
    })).item;
    assert.equal(process.env[environmentKey], "local");
    const importedConfigs = (await store.handle("config.import", {
      items: [{ source_id: "account-config-1", name: "Account defaults", values: { IMPORTED_SETTING: "yes" } }],
    })).items;
    assert.equal(importedConfigs[0].source.scope, "account");
    assert.equal(process.env.IMPORTED_SETTING, "yes");
    const configList = await store.handle("config.list");
    assert.equal("values" in configList.items[0], false);
    assert.ok(configList.items.some((item) => item.keys.includes("IMPORTED_SETTING")));
    assert.equal((await store.handle("config.get", { config_id: localConfig.config_id })).item.values[environmentKey], "local");
    await store.handle("config.update", {
      config_id: localConfig.config_id,
      name: "Updated runtime",
      values: { [environmentKey]: "updated" },
    });
    assert.equal(process.env[environmentKey], "updated");
    assert.equal((await store.handle("config.delete", { config_id: localConfig.config_id })).deleted, true);
    assert.equal(process.env[environmentKey], undefined);
    assert.equal(JSON.parse(await readFile(resolve(local.config, "applied.json"), "utf8")).values.IMPORTED_SETTING, "yes");

    const localSecret = (await store.handle("secret.create", {
      name: "LOCAL_TOKEN",
      values: { api_key: "local-secret-value", org_id: "org-42" },
    })).item;
    assert.deepEqual(localSecret.keys, ["api_key", "org_id"]);
    assert.equal(await readFile(resolve(local.syncedSecrets, "LOCAL_TOKEN", "api_key"), "utf8"), "local-secret-value");
    assert.equal((await stat(resolve(local.syncedSecrets, "LOCAL_TOKEN", "api_key"))).mode & 0o777, 0o600);
    assert.equal((await stat(resolve(local.syncedSecrets, "LOCAL_TOKEN"))).mode & 0o777, 0o700);
    const importedSecrets = (await store.handle("secret.import", {
      items: [{ source_id: "account-secret-1", name: "ACCOUNT_TOKEN", values: { token: "account-secret-value" } }],
    })).items;
    assert.equal(importedSecrets[0].source.scope, "account");
    assert.deepEqual(importedSecrets[0].keys, ["token"]);
    assert.doesNotMatch(JSON.stringify(await store.handle("secret.list")), /local-secret-value|account-secret-value/);
    // A null value keeps the stored key file; only a key carrying a value is rewritten.
    await store.handle("secret.update", {
      secret_id: localSecret.secret_id,
      name: "LOCAL_TOKEN",
      values: { api_key: null, org_id: "org-99" },
    });
    assert.equal(await readFile(resolve(local.syncedSecrets, "LOCAL_TOKEN", "api_key"), "utf8"), "local-secret-value");
    assert.equal(await readFile(resolve(local.syncedSecrets, "LOCAL_TOKEN", "org_id"), "utf8"), "org-99");
    // A kept value is read from the directory the secret is being renamed away from.
    await store.handle("secret.update", {
      secret_id: localSecret.secret_id,
      name: "KEPT_TOKEN",
      values: { api_key: null },
    });
    assert.equal(await readFile(resolve(local.syncedSecrets, "KEPT_TOKEN", "api_key"), "utf8"), "local-secret-value");
    await assert.rejects(store.handle("secret.update", {
      secret_id: localSecret.secret_id,
      name: "KEPT_TOKEN",
      values: { api_key: null, missing: null },
    }), /no stored value to keep for missing/);
    // Nothing is stored yet on a create, so a null is just a missing value.
    await assert.rejects(store.handle("secret.create", { name: "NEW_TOKEN", values: { api_key: null } }), /1 to 1000000 bytes/);
    await store.handle("secret.update", {
      secret_id: localSecret.secret_id,
      name: "RENAMED_TOKEN",
      values: { api_key: "replacement-value" },
    });
    assert.equal(await readFile(resolve(local.syncedSecrets, "RENAMED_TOKEN", "api_key"), "utf8"), "replacement-value");
    // An omitted key is dropped, and the directory goes with the rename.
    await assert.rejects(readFile(resolve(local.syncedSecrets, "RENAMED_TOKEN", "org_id")), { code: "ENOENT" });
    await assert.rejects(readFile(resolve(local.syncedSecrets, "LOCAL_TOKEN", "api_key")), { code: "ENOENT" });
    await assert.rejects(store.handle("secret.create", { name: "EMPTY", values: {} }), /at least one key/);
    assert.equal((await store.handle("secret.delete", { secret_id: localSecret.secret_id })).deleted, true);

    // An account refresh updates the imported copies and removes the revoked ones.
    const refreshed = await store.handle("account.refresh", {
      skills: [{ source_id: "account-skill-1", name: "Incident response", content: "# Incident response v3\n" }],
      configs: [{ source_id: "account-config-1", name: "Account defaults", values: { IMPORTED_SETTING: "refreshed" } }],
      secrets: [{ source_id: "account-secret-1", name: "ACCOUNT_TOKEN", values: { token: "rotated-value" } }],
    });
    assert.deepEqual(refreshed, {
      skills: { updated: 1, removed: 0 },
      configs: { updated: 1, removed: 0 },
      secrets: { updated: 1, removed: 0 },
    });
    assert.match((await store.handle("skill.get", { skill_id: importedSkills[0].skill_id })).item.content, /v3/);
    assert.equal(process.env.IMPORTED_SETTING, "refreshed");
    assert.equal(await readFile(resolve(local.syncedSecrets, "ACCOUNT_TOKEN", "token"), "utf8"), "rotated-value");

    const revoked = await store.handle("account.refresh", { skills: [], configs: [], secrets: [] });
    assert.deepEqual(revoked, {
      skills: { updated: 0, removed: 1 },
      configs: { updated: 0, removed: 1 },
      secrets: { updated: 0, removed: 1 },
    });
    // The manual skill written outside Zidane is never touched by an account sync.
    const survivingSkills = (await store.handle("skill.list")).items;
    assert.deepEqual(survivingSkills.map((item) => item.name), ["manual-skill"]);
    assert.equal(process.env.IMPORTED_SETTING, undefined);
    await assert.rejects(stat(resolve(local.syncedSecrets, "ACCOUNT_TOKEN")), { code: "ENOENT" });
    assert.equal((await store.handle("secret.list")).items.length, 0);
  } finally {
    delete process.env[environmentKey];
    delete process.env.IMPORTED_SETTING;
    await rm(root, { recursive: true, force: true });
  }
});
