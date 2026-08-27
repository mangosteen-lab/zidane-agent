import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { AgentDataStore } from "../src/agent-data.mjs";
import { initialise } from "../src/config.mjs";

test("agent-owned skills and config maps support local CRUD and account imports", async () => {
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

    const firstSync = await store.handle("account.refresh", {
      skills: [{ source_id: "account-skill-1", name: "Incident response", content: "# Incident response\n" }],
      configs: [],
    });
    assert.deepEqual(firstSync.skills, { created: 1, updated: 0, removed: 0 });
    const importedSkills = (await store.handle("skill.list")).items.filter((item) => item.source.scope === "account");
    assert.equal(importedSkills[0].source.scope, "account");
    assert.equal(importedSkills[0].source.id, "account-skill-1");
    // Re-importing the same account skill updates the copy in place.
    await store.handle("account.refresh", {
      skills: [{ source_id: "account-skill-1", name: "Incident response", content: "# Incident response v2\n" }],
      configs: [],
    });
    // A kind left empty means nothing is shared, so the copies go.
    assert.equal((await store.handle("config.list")).items.filter((item) => item.sync).length, 0);
    const reimported = (await store.handle("skill.list")).items.filter((item) => item.source.scope === "account");
    assert.equal(reimported[0].skill_id, importedSkills[0].skill_id);
    assert.equal((await store.handle("skill.list")).items.filter((item) => item.source.scope === "account").length, 1);
    assert.match((await store.handle("skill.get", { skill_id: reimported[0].skill_id })).item.content, /v2/);

    const localConfig = (await store.handle("config.create", {
      name: "LOCAL_RUNTIME",
      title: "Local runtime",
      normal_values: { [environmentKey]: "local", "setting.with.dots": "stored" },
      secret_values: ["LOCAL_RUNTIME_TOKEN"],
    })).item;
    assert.equal(process.env[environmentKey], "local");
    await store.handle("account.refresh", {
      skills: [{ source_id: "account-skill-1", name: "Incident response", content: "# Incident response v2\n" }],
      configs: [{ source_id: "account-config-1", name: "ACCOUNT_DEFAULTS", title: "Account defaults", normal_values: { IMPORTED_SETTING: "yes" } }],
    });
    const importedConfigs = (await store.handle("config.list")).items.filter((item) => item.sync);
    // `sync` marks the copies the control plane is responsible for.
    assert.equal(importedConfigs[0].sync, true);
    assert.equal(importedConfigs[0].source_id, "account-config-1");
    assert.equal(localConfig.sync, false);
    assert.equal(localConfig.title, "Local runtime");
    assert.equal(process.env.IMPORTED_SETTING, "yes");
    // One JSON record per map, values inline, secrets by name only.
    const record = JSON.parse(await readFile(resolve(root, "config-maps", "LOCAL_RUNTIME.json"), "utf8"));
    assert.equal(record.title, "Local runtime");
    assert.equal(record.normal_values[environmentKey], "local");
    assert.deepEqual(record.secret_values, ["LOCAL_RUNTIME_TOKEN"]);
    await assert.rejects(stat(resolve(root, "config", "agent-config-maps")), { code: "ENOENT" });

    const configList = await store.handle("config.list");
    assert.equal("normal_values" in configList.items[0], false);
    assert.ok(configList.items.some((item) => item.normal_keys.includes("IMPORTED_SETTING")));
    assert.equal((await store.handle("config.get", { config_id: localConfig.name })).item.normal_values[environmentKey], "local");
    const renamedConfig = (await store.handle("config.update", {
      config_id: localConfig.name,
      name: "UPDATED_RUNTIME",
      title: "Updated runtime",
      normal_values: { [environmentKey]: "updated" },
    })).item;
    assert.equal(process.env[environmentKey], "updated");
    // A rename moves the directory, so the old one is gone with it.
    assert.equal(renamedConfig.name, "UPDATED_RUNTIME");
    await assert.rejects(stat(resolve(root, "config-maps", "LOCAL_RUNTIME.json")), { code: "ENOENT" });
    assert.equal((await store.handle("config.delete", { config_id: renamedConfig.name })).deleted, true);
    assert.equal(process.env[environmentKey], undefined);
    assert.equal(JSON.parse(await readFile(resolve(local.config, "applied.json"), "utf8")).values.IMPORTED_SETTING, "yes");

    // An account refresh updates the imported copies and removes the revoked ones.
    const refreshed = await store.handle("account.refresh", {
      skills: [{ source_id: "account-skill-1", name: "Incident response", content: "# Incident response v3\n" }],
      configs: [{ source_id: "account-config-1", name: "ACCOUNT_DEFAULTS", title: "Account defaults", normal_values: { IMPORTED_SETTING: "refreshed" } }],
    });
    assert.deepEqual(refreshed, {
      skills: { created: 0, updated: 1, removed: 0 },
      configs: { created: 0, updated: 1, removed: 0 },
    });
    assert.match((await store.handle("skill.get", { skill_id: importedSkills[0].skill_id })).item.content, /v3/);
    assert.equal(process.env.IMPORTED_SETTING, "refreshed");

    const revoked = await store.handle("account.refresh", { skills: [], configs: [] });
    assert.deepEqual(revoked, {
      skills: { created: 0, updated: 0, removed: 1 },
      configs: { created: 0, updated: 0, removed: 1 },
    });
    // The manual skill written outside Zidane is never touched by an account sync.
    const survivingSkills = (await store.handle("skill.list")).items;
    assert.deepEqual(survivingSkills.map((item) => item.name), ["manual-skill"]);
    assert.equal(process.env.IMPORTED_SETTING, undefined);
  } finally {
    delete process.env[environmentKey];
    delete process.env.IMPORTED_SETTING;
    await rm(root, { recursive: true, force: true });
  }
});
