import assert from "node:assert/strict";
import { test } from "node:test";
import { contextTools } from "../src/context-tools.mjs";

const byName = (tools, name) => tools.find((tool) => tool.name === name);

test("a session can mark the message it is answering, and only that one", async () => {
  const sent = [];
  const tools = contextTools({}, null, null, { react: (emoji, remove) => sent.push([emoji, remove]) });
  const react = byName(tools, "react");
  assert.ok(react, "the tool is offered when there is a delivery to mark");

  const put = await react.execute("1", { emoji: "🔨" });
  assert.deepEqual(sent, [["🔨", false]]);
  assert.match(JSON.stringify(put), /🔨/);
  await react.execute("2", { emoji: "🔨", remove: true });
  assert.deepEqual(sent[1], ["🔨", true]);

  // A summary, a compaction or a scheduled run is answering nobody: no message to mark.
  assert.equal(byName(contextTools({}, null, null, {}), "react"), undefined);
});
