import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { AgentDataStore, skillIdentity, withSkillIdentity } from "../src/agent-data.mjs";
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
    assert.deepEqual(refreshed.skills, { created: 0, updated: 1, removed: 0 });
    assert.deepEqual(refreshed.configs, { created: 0, updated: 1, removed: 0 });
    assert.match((await store.handle("skill.get", { skill_id: importedSkills[0].skill_id })).item.content, /v3/);
    assert.equal(process.env.IMPORTED_SETTING, "refreshed");

    const revoked = await store.handle("account.refresh", { skills: [], configs: [] });
    assert.deepEqual(revoked.skills, { created: 0, updated: 0, removed: 1 });
    assert.deepEqual(revoked.configs, { created: 0, updated: 0, removed: 1 });
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

test("a skill's frontmatter carries the identity, and the file is what is believed", () => {
  const skill = "---\nname: deploy\ndescription: Ship it\n---\n\n# Deploy\n";
  assert.equal(skillIdentity(skill), "");
  assert.equal(skillIdentity("---\nid: abc-123\nname: deploy\n---\nbody\n"), "abc-123");
  assert.equal(skillIdentity('---\nid: "quoted-1"\n---\n'), "quoted-1");
  // Nothing that could be mistaken for a path or an injection is accepted as an id.
  assert.equal(skillIdentity("---\nid: ../../etc/passwd\n---\n"), "");
  assert.equal(skillIdentity("# No frontmatter\nid: nope\n"), "");

  // Stamping is idempotent and leaves the rest of the block alone.
  const stamped = withSkillIdentity(skill, "skill-1");
  assert.equal(skillIdentity(stamped), "skill-1");
  assert.match(stamped, /name: deploy/);
  assert.match(stamped, /# Deploy/);
  assert.equal(withSkillIdentity(stamped, "skill-1"), stamped);
  // A different id replaces the one declared rather than adding a second line.
  const restamped = withSkillIdentity(stamped, "skill-2");
  assert.equal(skillIdentity(restamped), "skill-2");
  assert.equal(restamped.match(/^id:/gm).length, 1);
  // A file with no frontmatter gets one, and keeps its body.
  const bare = withSkillIdentity("# Just a body\n", "skill-3");
  assert.equal(skillIdentity(bare), "skill-3");
  assert.match(bare, /# Just a body/);
});

test("the same skill is recognisable between the agent and the account", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zidane-skill-identity-test-"));
  try {
    const local = await initialise({ name: "test", version: "1", description: "", capacity: 1, workingDirectory: root });
    const store = new AgentDataStore(local);

    // A skill created without an id is given one, and it is written into the file.
    const minted = (await store.handle("skill.create", {
      name: "Release notes",
      content: "---\nname: release-notes\ndescription: Write release notes\n---\n\n# Release notes\n",
    })).item;
    assert.equal(skillIdentity(minted.content), minted.skill_id);
    assert.equal(
      skillIdentity(await readFile(resolve(local.skills, "release-notes", "SKILL.md"), "utf8")),
      minted.skill_id,
    );

    // One that arrives carrying an id keeps it: that is what makes a restored export or
    // a copy promoted to the account the same skill rather than a look-alike.
    const carried = (await store.handle("skill.create", {
      name: "Triage",
      content: "---\nid: shared-identity-1\nname: triage\ndescription: Triage a page\n---\n\n# Triage\n",
    })).item;
    assert.equal(carried.skill_id, "shared-identity-1");

    // An id already in use here is not transferable by pasting it.
    const impostor = (await store.handle("skill.create", {
      name: "Impostor",
      content: "---\nid: shared-identity-1\nname: impostor\ndescription: Not triage\n---\n",
    })).item;
    assert.notEqual(impostor.skill_id, "shared-identity-1");
    assert.equal(skillIdentity(impostor.content), impostor.skill_id);
    assert.match((await store.handle("skill.get", { skill_id: "shared-identity-1" })).item.content, /# Triage/);

    // Editing cannot drop the identity or rebind it to another skill.
    const edited = (await store.handle("skill.update", {
      skill_id: carried.skill_id,
      name: "Triage",
      content: "---\nid: someone-elses-id\nname: triage\ndescription: Triage a page\n---\n\n# Triage v2\n",
    })).item;
    assert.equal(edited.skill_id, "shared-identity-1");
    assert.equal(skillIdentity(edited.content), "shared-identity-1");

    // The account now shares a skill this agent already holds under the same identity —
    // the copy is updated in place instead of a twin appearing beside it.
    const sync = await store.handle("account.refresh", {
      skills: [{ source_id: "shared-identity-1", name: "Triage", content: "# Triage v3\n" }],
      configs: [],
    });
    assert.deepEqual(sync.skills, { created: 0, updated: 1, removed: 0 });
    const adopted = (await store.handle("skill.list")).items.filter((item) => item.skill_id === "shared-identity-1");
    assert.equal(adopted.length, 1);
    assert.deepEqual(adopted[0].source, { scope: "account", id: "shared-identity-1" });
    const stored = (await store.handle("skill.get", { skill_id: "shared-identity-1" })).item;
    assert.match(stored.content, /# Triage v3/);
    assert.equal(skillIdentity(stored.content), "shared-identity-1");

    // Publishing a skill to the account binds this copy to the row it created, so the
    // next sync updates this directory rather than importing a twin of it.
    const runbook = (await store.handle("skill.create", {
      name: "Runbook",
      content: "---\nname: runbook\ndescription: A runbook\n---\n\n# Runbook\n",
    })).item;
    const bound = (await store.handle("skill.adopt", {
      skill_id: runbook.skill_id,
      source_id: "account-row-9",
    })).item;
    assert.equal(bound.skill_id, "account-row-9");
    assert.deepEqual(bound.source, { scope: "account", id: "account-row-9" });
    assert.equal(skillIdentity(bound.content), "account-row-9");
    assert.match(bound.content, /# Runbook/);
    const afterPublish = await store.handle("account.refresh", {
      skills: [
        { source_id: "shared-identity-1", name: "Triage", content: "# Triage v3\n" },
        { source_id: "account-row-9", name: "Runbook", content: "# Runbook v2\n" },
      ],
      configs: [],
    });
    assert.deepEqual(afterPublish.skills, { created: 0, updated: 2, removed: 0 });
    assert.equal((await store.handle("skill.list")).items.filter((item) => item.name === "Runbook").length, 1);

    // A hand-placed skill is still nobody's copy: a sync leaves it exactly where it is.
    const manual = resolve(local.skills, "hand-placed");
    await mkdir(manual, { recursive: true });
    await writeFile(resolve(manual, "SKILL.md"), "---\nname: hand-placed\ndescription: Mine\n---\n");
    await store.handle("account.refresh", { skills: [], configs: [] });
    assert.equal((await readFile(resolve(manual, "SKILL.md"), "utf8")).includes("id:"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
