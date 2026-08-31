import { readFile, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import process from "node:process";
import WebSocket from "ws";
import { AgentDataStore } from "./agent-data.mjs";
import {
  applyAgentInfo,
  applyResource,
  applyState,
  clearSessionToken,
  configFromEnv,
  initialise,
  readSessionToken,
  resolveLlmProfile,
  writeSessionToken,
} from "./config.mjs";
import { CronScheduler, CronStore } from "./cron.mjs";
import { FollowUpScheduler, FollowUpStore } from "./follow-up.mjs";
import { DailyJournal } from "./daily.mjs";
import { KnowledgeStore } from "./knowledge.mjs";
import { AgentLogger } from "./logger.mjs";
import { PiAuthManager } from "./llm-auth.mjs";
import { MemoryStore } from "./memory.mjs";
import { loadModelCatalog } from "./model-catalog.mjs";
import { exportAgent, importAgent } from "./portable.mjs";
import { PiRuntime } from "./runtime.mjs";

const config = configFromEnv();
const local = await initialise(config);
let socket;
let agentId = "";
let stopped = false;
let reconnectAttempts = 0;
let incoming = Promise.resolve();

function frame(type, fields = {}) {
  return {
    type,
    protocol_version: 1,
    message_id: crypto.randomUUID(),
    agent_id: agentId || undefined,
    ...fields,
  };
}

function send(type, fields = {}) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(frame(type, fields)));
  return true;
}

const logger = new AgentLogger(local, (level, message, fields) => {
  if (agentId) send("LOG", { level, message, fields });
});
// The resolved layout, so `docker logs` shows the truth even when the image's baked
// AI_AGENT_*_FOLDER defaults were built against a different working directory.
logger.log("info", "agent storage ready", {
  working_directory: local.root,
  config_maps: process.env.AI_AGENT_CONFIG_MAPS_FOLDER,
  knowledge: process.env.AI_AGENT_KNOWLEDGE_FOLDER,
});
const memory = new MemoryStore(local);
const journal = new DailyJournal(local, logger);
const runtime = new PiRuntime(config, local, send, logger, memory, journal);
const knowledge = new KnowledgeStore(local, logger);
const llmAuth = new PiAuthManager(local, send, logger);
const cronStore = new CronStore(local);
// Scheduled runs get a lane of their own so a nightly task is never refused because
// someone is chatting, and a shared midnight schedule cannot open a session per task.
const cron = new CronScheduler(cronStore, runtime, logger, {
  limit: Number.parseInt(process.env.ZIDANE_AGENT_CRON_CONCURRENCY ?? "3", 10) || 3,
  intervalMs: (Number.parseInt(process.env.ZIDANE_AGENT_CRON_INTERVAL_SECONDS ?? "30", 10) || 30) * 1_000,
  // A finished run reports itself: nothing is emitted while it works, but what it did
  // becomes a direct message and a thread that resumes its session.
  emit: send,
});
// A conversation that asked to be woken later. Unlike cron this shares the ordinary
// capacity: a wake speaks in a conversation, so it costs what a conversation costs, and
// being refused while that conversation is busy just means trying again on the next tick.
const followUps = new FollowUpStore(local);
const followUpScheduler = new FollowUpScheduler(followUps, runtime, logger, {
  intervalMs: (Number.parseInt(process.env.ZIDANE_AGENT_FOLLOW_UP_INTERVAL_SECONDS ?? "30", 10) || 30) * 1_000,
});
const agentData = new AgentDataStore(local, knowledge, cron, followUps);
// A session saves a skill through the same store the REST relay uses.
runtime.data = agentData;
runtime.followUps = followUps;
let modelCatalog = [];
try {
  modelCatalog = await loadModelCatalog(local);
} catch (error) {
  logger.log("warning", "Pi model catalog could not be loaded", { error: String(error) });
}
await knowledge.start();
if ((process.env.ZIDANE_AGENT_CRON ?? "true") !== "false") cron.start();
if ((process.env.ZIDANE_AGENT_FOLLOW_UPS ?? "true") !== "false") followUpScheduler.start();

// The day's work is summarised into memory once the day is over. Checked on a slow
// timer rather than scheduled for an hour: an agent that was asleep at midnight, or
// restarted, still catches up on the next tick.
const digestEvery = Math.max(60, Number.parseInt(process.env.ZIDANE_AGENT_DIGEST_INTERVAL_SECONDS ?? "900", 10) || 900);
const digestEnabled = (process.env.ZIDANE_AGENT_DAILY_DIGEST ?? "true") !== "false";
const digestTimer = digestEnabled
  ? setInterval(() => {
      void journal.digest(runtime, memory).catch((error) => {
        // Being at capacity is the ordinary case, not a fault: try again later.
        if (error?.reason !== "capacity" && error?.reason !== "conversation") {
          logger.log("warning", "daily digest failed", { error: String(error) });
        }
      });
    }, digestEvery * 1_000)
  : null;
digestTimer?.unref();

let lastCpu = process.cpuUsage();
let lastCpuAt = process.hrtime.bigint();

/**
 * How much memory this agent may actually use.
 *
 * `os.totalmem()` reports the host, which in a container is not the limit the agent
 * will be killed for exceeding. The cgroup knows better when there is one.
 */
async function memoryLimit() {
  for (const path of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      const raw = (await readFile(path, "utf8")).trim();
      const value = Number(raw);
      // cgroup v2 writes "max" when unlimited, v1 writes an absurd sentinel.
      if (Number.isFinite(value) && value > 0 && value < os.totalmem()) return value;
    } catch { /* not cgroup-managed, or not readable */ }
  }
  return os.totalmem();
}

/**
 * What the console shows about this agent.
 *
 * CPU is a share of one core over the interval since the last sample, because a
 * cumulative counter means nothing to a reader. Disk is the filesystem holding the
 * working directory — the thing that actually fills up with sessions and workspaces.
 */
async function telemetry() {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  const at = process.hrtime.bigint();
  const elapsed = Number(at - lastCpuAt) / 1_000;
  const spent = cpu.user - lastCpu.user + (cpu.system - lastCpu.system);
  lastCpu = cpu;
  lastCpuAt = at;

  let disk = {};
  try {
    const stats = await statfs(local.root);
    const total = Number(stats.blocks) * Number(stats.bsize);
    disk = {
      disk_total_bytes: total,
      // `bavail` is what this user may actually use, which is what matters here.
      disk_used_bytes: total - Number(stats.bavail) * Number(stats.bsize),
    };
  } catch { /* not every filesystem answers statfs */ }

  let llm = null;
  try {
    const profile = await resolveLlmProfile(local, "");
    if (profile.provider) llm = { name: profile.name ?? null, provider: profile.provider, model: profile.model };
  } catch { /* no profile selected yet */ }

  return {
    capacity_used: runtime.active,
    capacity: config.capacity,
    uptime_seconds: process.uptime(),
    rss_bytes: memory.rss,
    heap_used_bytes: memory.heapUsed,
    heap_total_bytes: memory.heapTotal,
    external_bytes: memory.external,
    cpu_user_micros: cpu.user,
    cpu_system_micros: cpu.system,
    cpu_percent: elapsed > 0 ? Math.min(100, Math.round((spent / elapsed) * 1_000) / 10) : 0,
    memory_total_bytes: await memoryLimit(),
    load_average: os.loadavg(),
    llm,
    ...disk,
  };
}

async function handleMessage(message) {
  if (message.type === "REGISTERED") {
    agentId = message.agent_id;
    reconnectAttempts = 0;
    if (message.session_token) {
      await writeSessionToken(local, message.session_token);
    }
    logger.log("info", "agent registered", { agent_id: agentId });
    // A task that finished while the socket was down still reports itself, in order.
    if (cron.pending) {
      logger.log("info", "delivering scheduled-task reports held over the reconnect", { pending: cron.pending });
      cron.flush();
    }
    return;
  }
  if (message.type === "ERROR") {
    logger.log("error", "server rejected agent message", {
      code: message.code,
      detail: message.message,
    });
    if (message.code === "auth.invalid_session") {
      await clearSessionToken(local);
      socket.close();
    }
    return;
  }
  if (message.type === "PING") {
    send("PONG", { ping_sent_at: message.sent_at, ...(await telemetry()) });
    return;
  }
  if (message.type === "PROMPT") {
    try {
      runtime.prompt(message);
    } catch (error) {
      send("BUSY", {
        delivery_id: message.delivery_id,
        conversation_id: message.conversation_id,
        // `conversation` means wait for this thread; `capacity` means wait for a slot.
        reason: error?.reason ?? "capacity",
      });
    }
    return;
  }
  if (message.type === "COMPACT_THREAD") {
    try {
      // A conversation waiting on a check-back keeps its session. Compacting it would
      // hand the wake a summary of the work instead of the work, and the control plane
      // cannot know that: only the agent holds the pending wakes.
      const pending = await followUps.list();
      if (pending.some((item) => item.conversation_id === message.conversation_id)) {
        send("THREAD_COMPACT_FAILED", {
          conversation_id: message.conversation_id,
          error: "this conversation is waiting on a check-back",
        });
        logger.log("info", "thread kept for a pending check-back", { conversation_id: message.conversation_id });
        return;
      }
      const result = await runtime.compact(message.conversation_id);
      send("THREAD_COMPACTED", { conversation_id: message.conversation_id, ...result });
      logger.log("info", "thread compacted", { conversation_id: message.conversation_id, memory_id: result.memory_id });
    } catch (error) {
      // Left live on purpose: the control plane retries rather than losing the thread.
      send("THREAD_COMPACT_FAILED", { conversation_id: message.conversation_id, error: String(error) });
      logger.log("error", "thread compaction failed", { conversation_id: message.conversation_id, error: String(error) });
    }
    return;
  }
  if (message.type === "DELETE_THREAD") {
    try {
      await runtime.discard(message.conversation_id);
      send("THREAD_DELETED", { conversation_id: message.conversation_id });
    } catch (error) {
      send("THREAD_DELETE_FAILED", { conversation_id: message.conversation_id, error: String(error) });
    }
    return;
  }
  if (message.type === "CANCEL_PROMPT") {
    runtime.cancel(message.delivery_id);
    return;
  }
  if (message.type === "LLM_AUTH_START") {
    if (!llmAuth.start(message)) {
      send("LLM_AUTH_DONE", { flow_id: message.flow_id, configured: false, error: "authentication flow is already running" });
    }
    return;
  }
  if (message.type === "LLM_AUTH_INPUT") {
    if (!llmAuth.input(message)) {
      send("LLM_AUTH_DONE", { flow_id: message.flow_id, configured: false, error: "authentication prompt is no longer waiting" });
    }
    return;
  }
  if (message.type === "LLM_AUTH_CANCEL") {
    llmAuth.cancel(message.flow_id);
    return;
  }
  if (message.type === "AGENT_DATA") {
    try {
      const result = await agentData.handle(message.operation, message);
      send("AGENT_DATA_RESULT", {
        request_id: message.request_id,
        reply_server: message.reply_server,
        ok: true,
        result,
      });
    } catch (error) {
      send("AGENT_DATA_RESULT", {
        request_id: message.request_id,
        reply_server: message.reply_server,
        ok: false,
        error: String(error),
      });
    }
    return;
  }
  if (message.type === "APPLY_AGENT_INFO") {
    try {
      const info = await applyAgentInfo(local, config, message);
      send("AGENT_INFO_APPLIED", { revision: message.revision, ...info });
      logger.log("info", "agent basic information applied", {
        revision: message.revision,
        name: info.name,
        capacity: info.capacity,
      });
    } catch (error) {
      send("AGENT_INFO_REJECTED", { revision: message.revision, error: String(error) });
      logger.log("error", "agent basic information rejected", {
        revision: message.revision,
        error: String(error),
      });
    }
    return;
  }
  if (message.type === "APPLY_STATE") {
    try {
      await applyState(local, message.revision, message.config, message.secrets);
      send("STATE_APPLIED", { revision: message.revision });
      logger.log("info", "configuration state applied", { revision: message.revision });
    } catch (error) {
      send("STATE_REJECTED", { revision: message.revision, error: String(error) });
      logger.log("error", "configuration state rejected", {
        revision: message.revision,
        error: String(error),
      });
    }
    return;
  }
  if (message.type === "APPLY_RESOURCE") {
    try {
      await applyResource(local, message.resource_type, message.name, message.content);
      send("RESOURCE_APPLIED", {
        revision: message.revision,
        resource_type: message.resource_type,
        name: message.name,
      });
      logger.log("info", "agent resource applied", {
        revision: message.revision,
        resource_type: message.resource_type,
        name: message.name,
      });
    } catch (error) {
      send("RESOURCE_REJECTED", { revision: message.revision, error: String(error) });
      logger.log("error", "agent resource rejected", {
        revision: message.revision,
        error: String(error),
      });
    }
    return;
  }
  if (message.type === "MEMORY_QUERY") {
    try {
      const items = await memory.query(
        message.query,
        message.limit,
        Boolean(message.include_restricted),
      );
      send("MEMORY_RESULT", { request_id: message.request_id, reply_server: message.reply_server, ok: true, items });
    } catch (error) {
      send("MEMORY_RESULT", {
        request_id: message.request_id,
        reply_server: message.reply_server,
        ok: false,
        error: String(error),
      });
    }
    return;
  }
  if (message.type === "MEMORY_STORE") {
    try {
      const stored = await memory.add(message, "control-plane");
      send("MEMORY_RESULT", {
        request_id: message.request_id,
        reply_server: message.reply_server,
        ok: true,
        memory: stored,
      });
    } catch (error) {
      send("MEMORY_RESULT", {
        request_id: message.request_id,
        reply_server: message.reply_server,
        ok: false,
        error: String(error),
      });
    }
    return;
  }
  if (message.type === "MEMORY_DELETE") {
    const deleted = await memory.delete(String(message.memory_id ?? ""));
    send("MEMORY_RESULT", {
      request_id: message.request_id,
      reply_server: message.reply_server,
      ok: deleted,
    });
    return;
  }
  if (message.type === "EXPORT") {
    try {
      const result = await exportAgent(
        local,
        message.filename ?? `agent-${Date.now()}.tar.gz`,
      );
      const uploaded = await fetch(message.upload_url, {
        method: "PUT",
        headers: { "content-type": "application/gzip" },
        body: await readFile(result.archive),
      });
      if (!uploaded.ok) throw new Error(`upload failed: ${uploaded.status}`);
      send("EXPORT_READY", { export_id: message.export_id, manifest: result.manifest });
      logger.log("info", "agent export completed", { export_id: message.export_id });
    } catch (error) {
      send("EXPORT_READY", {
        export_id: message.export_id,
        status: "error",
        error: String(error),
      });
      logger.log("error", "agent export failed", {
        export_id: message.export_id,
        error: String(error),
      });
    }
    return;
  }
  if (message.type === "IMPORT") {
    try {
      const archive = resolve(local.exports, `import-${message.import_id}.tar.gz`);
      const downloaded = await fetch(message.download_url);
      if (!downloaded.ok) throw new Error(`download failed: ${downloaded.status}`);
      await writeFile(archive, Buffer.from(await downloaded.arrayBuffer()), {
        mode: 0o600,
      });
      const result = await importAgent(local, archive, message.mode);
      send("IMPORT_DONE", { import_id: message.import_id, ...result });
      logger.log("info", "agent import completed", {
        import_id: message.import_id,
        status: result.status,
      });
    } catch (error) {
      send("IMPORT_DONE", {
        import_id: message.import_id,
        status: "error",
        error: String(error),
      });
      logger.log("error", "agent import failed", {
        import_id: message.import_id,
        error: String(error),
      });
    }
  }
}

function reconnect() {
  if (stopped) return;
  const delay = Math.min(30_000, 1_000 * 2 ** reconnectAttempts);
  reconnectAttempts += 1;
  setTimeout(connect, delay + Math.floor(Math.random() * 500));
}

async function connect() {
  socket = new WebSocket(config.serverUrl, { maxPayload: 2 * 1024 * 1024 });
  socket.on("open", async () => {
    const sessionToken = await readSessionToken(local);
    send("REGISTER", {
      ...(sessionToken ? { session_token: sessionToken } : { api_key: config.apiKey }),
      name: config.name,
      version: config.version,
      description: config.description,
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      capacity: config.capacity,
      capabilities: {
        pi_sdk: true,
        parallel_sessions: config.capacity,
        agent_storage: { version: 6, resources: ["skills", "config_maps", "secrets", "llm_profiles", "crontab", "follow_ups"] },
        providers: modelCatalog.map((provider) => provider.id),
        model_catalog: modelCatalog,
      },
    });
  });
  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      incoming = incoming.then(() => handleMessage(message)).catch((error) => {
        logger.log("error", "server message handling failed", { error: String(error) });
      });
    } catch (error) {
      logger.log("warning", "invalid JSON received from server", { error: String(error) });
    }
  });
  socket.on("close", (code) => {
    agentId = "";
    logger.log("warning", "server connection closed", { code });
    reconnect();
  });
  socket.on("error", (error) => {
    logger.log("error", "server connection error", { error: String(error) });
  });
}

function shutdown(signal) {
  stopped = true;
  if (digestTimer) clearInterval(digestTimer);
  cron.stop();
  logger.log("info", "agent stopping", { signal });
  socket?.close(1001, "service stopping");
}

process.on("uncaughtException", (error) => {
  logger.log("critical", "uncaught exception", { error: String(error), stack: error.stack });
});
process.on("unhandledRejection", (error) => {
  logger.log("critical", "unhandled rejection", { error: String(error) });
});
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

await connect();
