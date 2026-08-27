import { readFile, writeFile } from "node:fs/promises";
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
  writeSessionToken,
} from "./config.mjs";
import { KnowledgeManager } from "./knowledge.mjs";
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
});
const memory = new MemoryStore(local);
const runtime = new PiRuntime(config, local, send, logger, memory);
const knowledge = new KnowledgeManager(local, send, logger);
const llmAuth = new PiAuthManager(local, send, logger);
const agentData = new AgentDataStore(local);
let modelCatalog = [];
try {
  modelCatalog = await loadModelCatalog(local);
} catch (error) {
  logger.log("warning", "Pi model catalog could not be loaded", { error: String(error) });
}
await knowledge.start();

function telemetry() {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
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
    load_average: os.loadavg(),
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
    send("PONG", { ping_sent_at: message.sent_at, ...telemetry() });
    return;
  }
  if (message.type === "PROMPT") {
    try {
      runtime.prompt(message);
    } catch {
      send("BUSY", {
        delivery_id: message.delivery_id,
        conversation_id: message.conversation_id,
      });
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
  if (message.type === "APPLY_KNOWLEDGE_SOURCE") {
    void knowledge.apply(message).catch(() => undefined);
    return;
  }
  if (message.type === "REMOVE_KNOWLEDGE_SOURCE") {
    try {
      await knowledge.remove(String(message.source_id ?? ""));
      logger.log("info", "knowledge source removed", { source_id: message.source_id });
    } catch (error) {
      logger.log("error", "knowledge source removal failed", {
        source_id: message.source_id,
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
        agent_storage: { version: 3, resources: ["skills", "config_maps", "secrets", "llm_profiles"] },
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
  knowledge.stop();
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
