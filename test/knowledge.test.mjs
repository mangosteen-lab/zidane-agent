import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { AgentDataStore } from "../src/agent-data.mjs";
import { KnowledgeStore, parseArticle } from "../src/knowledge.mjs";
import { initialise } from "../src/config.mjs";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("knowledge articles are synced from the account and feed the search index", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zidane-knowledge-test-"));
  try {
    const local = await initialise({ name: "t", version: "1", description: "", capacity: 1, workingDirectory: root });
    const knowledge = new KnowledgeStore(local, null);
    await knowledge.start();
    const store = new AgentDataStore(local, knowledge);

    const applied = await store.handle("account.refresh", {
      skills: [],
      configs: [],
      knowledge: [
        {
          id: "21e213ef-parent",
          name: "How To Articles",
          description: "A collection of how-to guides.",
          tags: ["How-To", "Guides"],
          content: "Everything below is a guide.",
          assets: [],
        },
        {
          id: "31e213ef-child",
          name: "How To Configure NFS Server on CentOS 7",
          description: "Setting up NFS on CentOS 7.",
          tags: ["CentOS", "NFS"],
          parent_id: "21e213ef-parent",
          content: "![alt text](image.png)\n\n### Server\n\nInstall nfs-utils.",
          assets: [{ name: "image.png", data: PNG.toString("base64") }],
        },
      ],
    });
    assert.deepEqual(applied.knowledge, { count: 2 });

    // One directory per article, holding its markdown and its images.
    const directory = resolve(root, "knowledge", "articles", "31e213ef-child");
    const files = (await readdir(directory)).sort();
    assert.deepEqual(files, ["How-To-Configure-NFS-Server-on-CentOS-7.md", "image.png"]);
    assert.deepEqual(await readFile(resolve(directory, "image.png")), PNG);

    // The markdown is frontmatter plus content, and reads back as it was written.
    const raw = await readFile(resolve(directory, "How-To-Configure-NFS-Server-on-CentOS-7.md"), "utf8");
    const parsed = parseArticle(raw, "fallback");
    assert.equal(parsed.id, "31e213ef-child");
    assert.equal(parsed.name, "How To Configure NFS Server on CentOS 7");
    assert.deepEqual(parsed.tags, ["CentOS", "NFS"]);
    assert.equal(parsed.parent_id, "21e213ef-parent");
    assert.match(parsed.content, /Install nfs-utils/);

    // The index `search_knowledge` reads is rebuilt from the articles.
    const index = JSON.parse(await readFile(resolve(root, "knowledge", "index.json"), "utf8"));
    assert.equal(index.some((chunk) => /nfs-utils/.test(chunk.text)), true);
    assert.equal(index.every((chunk) => chunk.source_id && chunk.title), true);

    // A later sync is the whole picture: an article no longer shared is removed.
    await store.handle("account.refresh", {
      skills: [],
      configs: [],
      knowledge: [{ id: "21e213ef-parent", name: "How To Articles", description: "", tags: [], content: "Still here." }],
    });
    await assert.rejects(stat(directory), { code: "ENOENT" });
    const after = JSON.parse(await readFile(resolve(root, "knowledge", "index.json"), "utf8"));
    assert.equal(after.every((chunk) => chunk.source_id === "21e213ef-parent"), true);

    // A traversal in an asset name never reaches outside the article.
    await assert.rejects(
      store.handle("account.refresh", {
        skills: [], configs: [],
        knowledge: [{ id: "bad", name: "Bad", content: "x", assets: [{ name: "../escape.png", data: "" }] }],
      }),
      /unsafe knowledge asset name/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
