import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const script = new URL("../scripts/install-container.sh", import.meta.url).pathname;

function helper(expression) {
  return execFileSync("bash", ["-c", `set -euo pipefail; . "$1"; ${expression}`, "bash", script], {
    env: { ...process.env, ZIDANE_INSTALL_SOURCE_ONLY: "1", ZIDANE_INSTALL_ROOT: "/opt/mangosteen" },
    encoding: "utf8",
  }).trim();
}

test("the installer pins the image of the release it ships with", async () => {
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const source = await readFile(script, "utf8");
  assert.equal(source.match(/^ZIDANE_AGENT_RELEASE=(.+)$/m)?.[1], version);
});

test("a pasted console address becomes the agent endpoint", () => {
  assert.equal(helper('normalize_url "https://zidane.example.com"'), "wss://zidane.example.com/ws/agent");
  assert.equal(helper('normalize_url "http://10.0.0.5:17001/"'), "ws://10.0.0.5:17001/ws/agent");
  assert.equal(helper('normalize_url "  wss://z.example.com:8443/ws/agent  "'), "wss://z.example.com:8443/ws/agent");
  assert.equal(helper('normalize_url "zidane.example.com" || echo invalid'), "invalid");
  assert.equal(helper('url_host "ws://[::1]:17001/ws/agent"'), "::1");
});

test("state lives under /opt/mangosteen/zidane-agent-<container>", () => {
  assert.equal(helper("data_dir_for qa"), "/opt/mangosteen/zidane-agent-qa");
  assert.equal(helper("data_dir_for zidane-agent-qa"), "/opt/mangosteen/zidane-agent-qa");
  assert.equal(helper('valid_container "../etc" || echo invalid'), "invalid");
});
