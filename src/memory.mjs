import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const SENSITIVITY = new Set(["normal", "private", "restricted"]);
const MAX_MEMORIES = 10_000;

export class MemoryStore {
  #pending = Promise.resolve();

  constructor(local) {
    this.file = resolve(local.memory, "memory.json");
  }

  add(input, source = "agent") {
    return this.#mutate(async (entries) => {
      const text = String(input.text ?? "").trim();
      if (!text || text.length > 10_000) throw new Error("memory text must contain 1 to 10000 characters");
      if (containsCredential(text)) throw new Error("credentials and secret material cannot be stored in memory");
      const sensitivity = String(input.sensitivity ?? "normal");
      if (!SENSITIVITY.has(sensitivity)) throw new Error("invalid memory sensitivity");
      const tags = [...new Set((input.tags ?? []).map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 20);
      if (tags.some((tag) => tag.length > 80)) throw new Error("memory tags cannot exceed 80 characters");
      const timestamp = Date.now();
      const ttlDays = input.ttl_days == null ? null : Number(input.ttl_days);
      if (ttlDays != null && (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 3650)) {
        throw new Error("memory ttl_days must be between 1 and 3650");
      }
      const entry = {
        id: crypto.randomUUID(),
        text,
        tags,
        sensitivity,
        source,
        created_at: timestamp,
        updated_at: timestamp,
        expires_at: ttlDays ? timestamp + ttlDays * 86_400_000 : null,
        access_count: 0,
        last_accessed_at: null,
      };
      entries.push(entry);
      if (entries.length > MAX_MEMORIES) {
        entries.sort((a, b) => (b.last_accessed_at ?? b.created_at) - (a.last_accessed_at ?? a.created_at));
        entries.length = MAX_MEMORIES;
      }
      return { result: publicMemory(entry), entries };
    });
  }

  query(query, limit = 20, includeRestricted = false) {
    return this.#mutate(async (entries) => {
      const terms = tokens(query);
      const phrase = String(query ?? "").trim().toLowerCase();
      const matches = entries
        .filter((entry) => includeRestricted || entry.sensitivity !== "restricted")
        .map((entry) => ({ entry, score: relevance(entry, terms, phrase) }))
        .filter((item) => !terms.length || item.score > 0)
        .sort((a, b) => b.score - a.score || b.entry.updated_at - a.entry.updated_at)
        .slice(0, Math.max(1, Math.min(500, Number(limit) || 20)));
      const accessed = Date.now();
      for (const { entry } of matches) {
        entry.access_count = (entry.access_count ?? 0) + 1;
        entry.last_accessed_at = accessed;
      }
      return { result: matches.map(({ entry }) => publicMemory(entry)), entries };
    });
  }

  delete(memoryId) {
    return this.#mutate(async (entries) => {
      const kept = entries.filter((entry) => entry.id !== memoryId);
      return { result: kept.length !== entries.length, entries: kept };
    });
  }

  #mutate(operation) {
    const task = this.#pending.then(async () => {
      const entries = await this.#load();
      const active = entries.filter((entry) => !entry.expires_at || entry.expires_at > Date.now());
      const { result, entries: updated } = await operation(active);
      await this.#save(updated);
      return result;
    });
    this.#pending = task.catch(() => undefined);
    return task;
  }

  async #load() {
    try {
      const value = JSON.parse(await readFile(this.file, "utf8"));
      if (!Array.isArray(value)) throw new Error("memory store is not an array");
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async #save(entries) {
    const pending = `${this.file}.new`;
    await writeFile(pending, JSON.stringify(entries, null, 2), { mode: 0o600 });
    await rename(pending, this.file);
  }
}

function publicMemory(entry) {
  return {
    id: entry.id,
    text: entry.text,
    tags: entry.tags,
    sensitivity: entry.sensitivity,
    source: entry.source,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    expires_at: entry.expires_at,
    access_count: entry.access_count ?? 0,
    last_accessed_at: entry.last_accessed_at ?? null,
  };
}

function tokens(input) {
  return String(input ?? "").toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
}

function relevance(entry, terms, phrase) {
  if (!terms.length) return 0;
  const text = entry.text.toLowerCase();
  const tags = entry.tags.join(" ").toLowerCase();
  let score = terms.reduce(
    (total, term) => total + (text.includes(term) ? 2 : 0) + (tags.includes(term) ? 3 : 0),
    0,
  );
  if (phrase && text.includes(phrase)) score += 5;
  return score;
}

function containsCredential(value) {
  return [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
    /\bBearer\s+[A-Za-z0-9._~-]{16,}/i,
    /\bzidane_(?:session_)?[A-Za-z0-9_-]{16,}/i,
    /\b(?:api.?key|password|secret|token)\s*[:=]\s*["']?[^\s"']{8,}/i,
    /\bsk-[A-Za-z0-9_-]{16,}/,
  ].some((pattern) => pattern.test(value));
}
