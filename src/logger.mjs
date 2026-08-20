import { appendFile, rename, stat } from "node:fs/promises";
import { resolve } from "node:path";

const SENSITIVE_KEY = /api.?key|authorization|cookie|password|secret|token/i;
const LEVELS = new Set(["debug", "info", "warning", "error", "critical"]);

export class AgentLogger {
  #pending = Promise.resolve();

  constructor(local, forward) {
    this.file = resolve(local.logs, "agent.jsonl");
    this.forward = forward;
    this.maxBytes = 10 * 1024 * 1024;
  }

  log(level, message, fields = {}) {
    const safeLevel = LEVELS.has(level) ? level : "info";
    const payload = {
      timestamp: new Date().toISOString(),
      level: safeLevel,
      message: scrubText(String(message)).slice(0, 10_000),
      fields: sanitise(fields),
    };
    const line = JSON.stringify(payload);
    const output = safeLevel === "error" || safeLevel === "critical" ? process.stderr : process.stdout;
    output.write(`${line}\n`);
    this.#pending = this.#pending
      .then(async () => {
        await this.#rotate(line.length + 1);
        await appendFile(this.file, `${line}\n`, { mode: 0o600 });
      })
      .catch(() => undefined);
    this.forward?.(safeLevel, payload.message, payload.fields);
  }

  async #rotate(incomingBytes) {
    try {
      const info = await stat(this.file);
      if (info.size + incomingBytes >= this.maxBytes) {
        await rename(this.file, `${this.file}.1`);
      }
    } catch {
      // The first log entry creates the file.
    }
  }
}

function sanitise(value) {
  try {
    return JSON.parse(JSON.stringify(value, (key, item) => {
      if (SENSITIVE_KEY.test(key)) return "[redacted]";
      return typeof item === "string" ? scrubText(item) : item;
    }));
  } catch {
    return { detail: "[unserializable]" };
  }
}

function scrubText(value) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .replace(/zidane_(?:session_)?[A-Za-z0-9_-]+/g, "zidane_[redacted]")
    .replace(/((?:api.?key|password|secret|token)\s*[:=]\s*)\S+/gi, "$1[redacted]");
}
