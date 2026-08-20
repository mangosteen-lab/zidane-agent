import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { initialise } from "../src/config.mjs";
import { KnowledgeManager } from "../src/knowledge.mjs";

let root;
let local;
let server;
let sourceUrl;

before(async () => {
  root = await mkdtemp(resolve(tmpdir(), "zidane-knowledge-test-"));
  local = await initialise({
    name: "test",
    version: "1.0.0",
    description: "test",
    workingDirectory: root,
  });
  server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/markdown" });
    response.end("# Handbook\n\nProduction changes require peer review.\n");
  });
  await new Promise((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
  const address = server.address();
  sourceUrl = `http://127.0.0.1:${address.port}/handbook.md`;
});

after(async () => {
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(root, { recursive: true, force: true });
});

test("HTTP knowledge sources build a cited local index", async () => {
  const events = [];
  const manager = new KnowledgeManager(
    local,
    (type, fields) => events.push({ type, ...fields }),
    { log() {} },
  );
  await manager.start();
  await manager.apply({
    source_id: "handbook",
    name: "Engineering handbook",
    kind: "http",
    url: sourceUrl,
    refresh_minutes: 60,
    config: {},
  });
  const index = JSON.parse(await readFile(resolve(local.knowledge, "index.json"), "utf8"));
  assert.equal(index.length, 1);
  assert.match(index[0].text, /peer review/);
  assert.equal(index[0].source, sourceUrl);
  assert.equal(events[0].type, "KNOWLEDGE_SYNCED");

  await manager.remove("handbook");
  const empty = JSON.parse(await readFile(resolve(local.knowledge, "index.json"), "utf8"));
  assert.deepEqual(empty, []);
  manager.stop();
});
