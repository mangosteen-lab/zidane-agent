import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { AgentDataStore, skillIdentity, withSkillIdentity } from "../src/agent-data.mjs";
import { contextTools } from "../src/context-tools.mjs";
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
    assert.partialDeepStrictEqual(firstSync.skills, { created: 1, updated: 0, removed: 0, pushed: 0, conflicts: 0 });
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
    assert.partialDeepStrictEqual(refreshed.skills, { created: 0, updated: 1, removed: 0 });
    assert.deepEqual(refreshed.configs, { created: 0, updated: 1, removed: 0 });
    assert.match((await store.handle("skill.get", { skill_id: importedSkills[0].skill_id })).item.content, /v3/);
    assert.equal(process.env.IMPORTED_SETTING, "refreshed");

    const revoked = await store.handle("account.refresh", { skills: [], configs: [] });
    assert.partialDeepStrictEqual(revoked.skills, { created: 0, updated: 0, removed: 1 });
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
    assert.partialDeepStrictEqual(sync.skills, { created: 0, updated: 1, removed: 0 });
    const adopted = (await store.handle("skill.list")).items.filter((item) => item.skill_id === "shared-identity-1");
    assert.equal(adopted.length, 1);
    assert.partialDeepStrictEqual(adopted[0].source, { scope: "account", id: "shared-identity-1", state: "synced" });
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
    assert.partialDeepStrictEqual(bound.source, { scope: "account", id: "account-row-9" });
    assert.equal(skillIdentity(bound.content), "account-row-9");
    assert.match(bound.content, /# Runbook/);
    const afterPublish = await store.handle("account.refresh", {
      skills: [
        { source_id: "shared-identity-1", name: "Triage", content: "# Triage v3\n" },
        { source_id: "account-row-9", name: "Runbook", content: "# Runbook v2\n" },
      ],
      configs: [],
    });
    // Triage is sent back exactly as it sits on disk, so the sync records its version
    // and writes nothing: an unchanged skill is no longer rewritten every six hours.
    assert.partialDeepStrictEqual(afterPublish.skills, { created: 0, updated: 1, unchanged: 1, removed: 0 });
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

test("a session can save what it worked out as a skill a later one will load", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zidane-draft-skill-test-"));
  try {
    const local = await initialise({ name: "t", version: "1", description: "", capacity: 1, workingDirectory: root });
    const store = new AgentDataStore(local);
    const draft = contextTools(local, null, store).find((tool) => tool.name === "draft_skill");
    assert.ok(draft, "the tool is offered when the agent has a data store");
    // Without a store there is nowhere to write, so the tool is not offered at all.
    assert.equal(contextTools(local, null).some((tool) => tool.name === "draft_skill"), false);

    const saved = await draft.execute("call-1", {
      name: "Release train",
      // A colon would end the key if this were written out unquoted, and Pi parses the
      // block as real YAML: the skill would fail to load rather than load wrongly.
      description: "Use when cutting a release: tags, notes, and the smoke check",
      instructions: "# Release train\n\n1. Tag it.\n2. Write the notes.\n",
    });
    assert.equal(saved.details.replaced, false);

    const stored = (await store.handle("skill.get", { skill_id: saved.details.skill_id })).item;
    const { frontmatter, body } = parseFrontmatter(stored.content);
    assert.equal(frontmatter.name, "release-train");
    assert.equal(frontmatter.description, "Use when cutting a release: tags, notes, and the smoke check");
    // The identity is stamped in by the store, and Pi reads straight past it.
    assert.equal(frontmatter.id, saved.details.skill_id);
    assert.match(body, /Tag it/);

    // Saving the same name again refines that skill rather than growing a second one.
    const again = await draft.execute("call-2", {
      name: "release train",
      description: "Use when cutting a release",
      instructions: "# Release train\n\n1. Tag it.\n2. Write the notes.\n3. Smoke test.\n",
    });
    assert.equal(again.details.replaced, true);
    assert.equal(again.details.skill_id, saved.details.skill_id);
    const listed = (await store.handle("skill.list")).items;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].source.scope, "agent");
    assert.match((await store.handle("skill.get", { skill_id: listed[0].skill_id })).item.content, /Smoke test/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an edit made on the agent goes up instead of being overwritten by the next sync", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zidane-skill-pushback-test-"));
  try {
    const local = await initialise({ name: "test", version: "1", description: "", capacity: 1, workingDirectory: root });
    const store = new AgentDataStore(local);
    const account = (content, version) => ({
      skills: [{ source_id: "account-skill-1", name: "Incident response", content, version }],
      configs: [],
    });
    let edited = 0;
    store.onAccountSkillEdited = () => { edited += 1; };

    await store.handle("account.refresh", account("# Incident response\n", 4));
    const imported = (await store.handle("skill.list")).items.find((item) => item.source.scope === "account");
    assert.equal(imported.source.state, "synced");

    // The same sync again writes nothing at all: an unchanged skill is left alone, so
    // nothing watching the directory sees a file that was never touched change.
    const untouched = await store.handle("account.refresh", account("# Incident response\n", 4));
    assert.partialDeepStrictEqual(untouched.skills, { created: 0, updated: 0, unchanged: 1, pushed: 0, conflicts: 0 });

    // Somebody improves the copy on the agent.
    await store.handle("skill.update", {
      skill_id: imported.skill_id,
      name: "Incident response",
      content: "# Incident response\n\nPage the on-call engineer first.\n",
    });
    assert.equal(edited, 1, "a local edit to an imported skill asks for a sync");
    assert.equal((await store.handle("skill.list")).items.find((item) => item.skill_id === imported.skill_id).source.state, "modified");

    // The account has not moved, so the edit is the newer of the two: it is handed up
    // and the file stays exactly as it was written here.
    const handedUp = await store.handle("account.refresh", account("# Incident response\n", 4));
    assert.partialDeepStrictEqual(handedUp.skills, { created: 0, updated: 0, unchanged: 0, pushed: 1, conflicts: 0 });
    assert.equal(handedUp.skills.push[0].source_id, "account-skill-1");
    assert.equal(handedUp.skills.push[0].base_version, 4);
    assert.match(handedUp.skills.push[0].content, /Page the on-call engineer first/);
    assert.match((await store.handle("skill.get", { skill_id: imported.skill_id })).item.content, /Page the on-call engineer first/);

    // The server adopted it, so the settling round brings the agent's own text back
    // under a new version. That is convergence, not a change — and not a conflict.
    const settled = await store.handle("account.refresh", account(
      withSkillIdentity("# Incident response\n\nPage the on-call engineer first.\n", "account-skill-1"),
      5,
    ));
    assert.partialDeepStrictEqual(settled.skills, { created: 0, updated: 0, unchanged: 1, pushed: 0, conflicts: 0 });
    assert.equal((await store.handle("skill.list")).items.find((item) => item.skill_id === imported.skill_id).source.state, "synced");

    // Now both sides move. Neither is thrown away: the local file stands, and the copy
    // says it is in conflict rather than pretending one of the two won.
    await store.handle("skill.update", {
      skill_id: imported.skill_id,
      name: "Incident response",
      content: "# Incident response\n\nPage the on-call engineer, then open a room.\n",
    });
    const clash = await store.handle("account.refresh", account("# Incident response\n\nRewritten in the console.\n", 9));
    assert.partialDeepStrictEqual(clash.skills, { created: 0, updated: 0, unchanged: 0, pushed: 0, conflicts: 1 });
    const held = (await store.handle("skill.list")).items.find((item) => item.skill_id === imported.skill_id);
    assert.equal(held.source.state, "conflict");
    assert.equal(held.source.conflict, 9);
    assert.match((await store.handle("skill.get", { skill_id: imported.skill_id })).item.content, /then open a room/);

    // Revoking visibility still takes the skill off the disk, edit and all: the account
    // has said this agent may not have it, and a private fork is not what that means.
    assert.partialDeepStrictEqual((await store.handle("account.refresh", { skills: [], configs: [] })).skills, { removed: 1 });
    assert.equal((await store.handle("skill.list")).items.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a copy synced before two-way sync is never mistaken for an edited one", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zidane-skill-legacy-test-"));
  try {
    const local = await initialise({ name: "test", version: "1", description: "", capacity: 1, workingDirectory: root });
    const store = new AgentDataStore(local);

    // What an older agent left behind: a sidecar with a source but no base to compare
    // against. It cannot prove an edit, so it does not claim one and the account wins.
    const directory = resolve(local.skills, "incident-response");
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, "SKILL.md"), withSkillIdentity("# Edited locally, long ago\n", "account-skill-1"));
    await writeFile(resolve(directory, ".zidane.json"), JSON.stringify({
      id: "account-skill-1",
      name: "Incident response",
      source: { scope: "account", id: "account-skill-1" },
      created_at: Date.now(),
      updated_at: Date.now(),
    }));

    const applied = await store.handle("account.refresh", {
      skills: [{ source_id: "account-skill-1", name: "Incident response", content: "# From the account\n", version: 3 }],
      configs: [],
    });
    assert.partialDeepStrictEqual(applied.skills, { created: 0, updated: 1, pushed: 0, conflicts: 0 });
    assert.match((await store.handle("skill.get", { skill_id: "account-skill-1" })).item.content, /From the account/);
    // From here on it has a base, so the next edit is recognisable as one.
    assert.equal((await store.handle("skill.list")).items[0].source.state, "synced");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a copy matched only by the identity in its file is linked before it is trusted", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zidane-skill-identity-link-test-"));
  try {
    const local = await initialise({ name: "test", version: "1", description: "", capacity: 1, workingDirectory: root });
    const store = new AgentDataStore(local);

    // Written here and carrying an id the account turns out to use — a restored export,
    // or a copy promoted from this agent by an older release. It has never been told a
    // version, so it cannot claim an edit: the account's content wins and it is linked.
    const written = (await store.handle("skill.create", {
      name: "Runbook",
      content: "---\nid: account-row-7\nname: runbook\ndescription: Mine\n---\n\n# Written here\n",
    })).item;
    assert.equal(written.source.scope, "agent");

    const applied = await store.handle("account.refresh", {
      skills: [{ source_id: "account-row-7", name: "Runbook", content: "# From the account\n", version: 5 }],
      configs: [],
    });
    assert.partialDeepStrictEqual(applied.skills, { created: 0, updated: 1, pushed: 0, conflicts: 0 });
    const linked = (await store.handle("skill.list")).items.find((item) => item.skill_id === "account-row-7");
    assert.equal(linked.source.scope, "account");
    assert.equal(linked.source.id, "account-row-7");
    assert.equal(linked.source.state, "synced");
    assert.equal(linked.source.version, 5);
    assert.equal((await store.handle("skill.list")).items.length, 1, "linked in place, not twinned");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
