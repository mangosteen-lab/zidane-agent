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

    const localSecret = (await store.handle("secret.create", { name: "LOCAL_TOKEN", value: "local-secret-value" })).item;
    assert.equal(await readFile(resolve(local.syncedSecrets, "LOCAL_TOKEN"), "utf8"), "local-secret-value");
    assert.equal((await stat(resolve(local.syncedSecrets, "LOCAL_TOKEN"))).mode & 0o777, 0o600);
    const importedSecrets = (await store.handle("secret.import", {
      items: [{ source_id: "account-secret-1", name: "ACCOUNT_TOKEN", value: "account-secret-value" }],
    })).items;
    assert.equal(importedSecrets[0].source.scope, "account");
    assert.doesNotMatch(JSON.stringify(await store.handle("secret.list")), /local-secret-value|account-secret-value/);
    await store.handle("secret.update", { secret_id: localSecret.secret_id, name: "RENAMED_TOKEN", value: "replacement-value" });
    assert.equal(await readFile(resolve(local.syncedSecrets, "RENAMED_TOKEN"), "utf8"), "replacement-value");
    await assert.rejects(readFile(resolve(local.syncedSecrets, "LOCAL_TOKEN")), { code: "ENOENT" });
    assert.equal((await store.handle("secret.delete", { secret_id: localSecret.secret_id })).deleted, true);
  } finally {
    delete process.env[environmentKey];
    delete process.env.IMPORTED_SETTING;
    await rm(root, { recursive: true, force: true });
  }
});
