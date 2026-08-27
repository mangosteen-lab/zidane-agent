import { Buffer } from "node:buffer";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const KINDS = new Set(["github", "notion", "confluence", "http"]);
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export class KnowledgeManager {
  #timers = new Map();
  #running = new Map();

  constructor(local, emit, logger) {
    this.local = local;
    this.emit = emit;
    this.logger = logger;
    this.connectors = resolve(local.knowledge, "connectors");
    this.sources = resolve(local.knowledge, "sources");
  }

  async start() {
    await mkdir(this.connectors, { recursive: true });
    await mkdir(this.sources, { recursive: true });
    for (const name of await readdir(this.connectors)) {
      if (!name.endsWith(".json")) continue;
      try {
        const source = JSON.parse(await readFile(resolve(this.connectors, name), "utf8"));
        this.#schedule(source);
      } catch (error) {
        this.logger.log("warning", "invalid stored knowledge connector", { name, error: String(error) });
      }
    }
  }

  async apply(message) {
    const source = validateSource(message);
    const credentialPath = this.#credentialPath(source.source_id);
    if (message.credential) {
      await writeFile(credentialPath, String(message.credential), { mode: 0o600 });
      source.credential_name = `knowledge-${source.source_id}`;
    } else {
      await rm(credentialPath, { force: true });
      source.credential_name = null;
    }
    await writeFile(
      resolve(this.connectors, `${source.source_id}.json`),
      JSON.stringify(source, null, 2),
      { mode: 0o600 },
    );
    this.#schedule(source);
    return this.sync(source);
  }

  async remove(sourceId) {
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(sourceId)) throw new Error("unsafe source id");
    clearInterval(this.#timers.get(sourceId));
    this.#timers.delete(sourceId);
    await Promise.all([
      rm(resolve(this.connectors, `${sourceId}.json`), { force: true }),
      rm(resolve(this.sources, `${sourceId}.json`), { force: true }),
      rm(this.#credentialPath(sourceId), { force: true }),
    ]);
    await this.#rebuildIndex();
  }

  async sync(source) {
    if (this.#running.has(source.source_id)) return this.#running.get(source.source_id);
    const task = this.#sync(source).finally(() => this.#running.delete(source.source_id));
    this.#running.set(source.source_id, task);
    return task;
  }

  stop() {
    for (const timer of this.#timers.values()) clearInterval(timer);
    this.#timers.clear();
  }

  #schedule(source) {
    clearInterval(this.#timers.get(source.source_id));
    const timer = setInterval(() => {
      void this.sync(source);
    }, source.refresh_minutes * 60_000);
    timer.unref();
    this.#timers.set(source.source_id, timer);
  }

  async #sync(source) {
    try {
      const credential = source.credential_name
        ? (await readFile(this.#credentialPath(source.source_id), "utf8")).trim()
        : "";
      const documents = await loadDocuments(source, credential);
      const chunks = documents.flatMap((document) => chunkDocument(source, document));
      const destination = resolve(this.sources, `${source.source_id}.json`);
      const pending = `${destination}.new`;
      await writeFile(pending, JSON.stringify(chunks, null, 2), { mode: 0o600 });
      await rename(pending, destination);
      await this.#rebuildIndex();
      this.emit("KNOWLEDGE_SYNCED", {
        source_id: source.source_id,
        document_count: documents.length,
        chunk_count: chunks.length,
      });
      this.logger.log("info", "knowledge source synchronized", {
        source_id: source.source_id,
        document_count: documents.length,
        chunk_count: chunks.length,
      });
      return { document_count: documents.length, chunk_count: chunks.length };
    } catch (error) {
      this.emit("KNOWLEDGE_SYNC_FAILED", {
        source_id: source.source_id,
        error: String(error),
      });
      this.logger.log("error", "knowledge source synchronization failed", {
        source_id: source.source_id,
        error: String(error),
      });
      throw error;
    }
  }

  async #rebuildIndex() {
    const index = [];
    for (const name of await readdir(this.sources)) {
      if (!name.endsWith(".json")) continue;
      try {
        const entries = JSON.parse(await readFile(resolve(this.sources, name), "utf8"));
        if (Array.isArray(entries)) index.push(...entries);
      } catch (error) {
        this.logger.log("warning", "knowledge source index is invalid", { name, error: String(error) });
      }
    }
    const destination = resolve(this.local.knowledge, "index.json");
    const pending = `${destination}.new`;
    await writeFile(pending, JSON.stringify(index, null, 2), { mode: 0o600 });
    await rename(pending, destination);
  }

  #credentialPath(sourceId) {
    return resolve(this.local.auth, `knowledge-${sourceId}`);
  }
}

function validateSource(message) {
  const sourceId = String(message.source_id ?? "");
  const kind = String(message.kind ?? "");
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(sourceId)) throw new Error("unsafe source id");
  if (!KINDS.has(kind)) throw new Error("unsupported knowledge source kind");
  const url = new URL(String(message.url ?? ""));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("knowledge source must use an HTTP(S) URL without credentials");
  }
  return {
    source_id: sourceId,
    name: String(message.name ?? sourceId),
    kind,
    url: url.toString(),
    refresh_minutes: Math.max(5, Math.min(10_080, Number(message.refresh_minutes) || 60)),
    config: message.config && typeof message.config === "object" ? message.config : {},
  };
}

async function loadDocuments(source, credential) {
  if (source.kind === "github") return loadGithub(source, credential);
  if (source.kind === "notion") return loadNotion(source, credential);
  if (source.kind === "confluence") return loadConfluence(source, credential);
  return loadHttp(source, credential);
}

async function loadHttp(source, credential) {
  const response = await request(source.url, {
    headers: credential ? { authorization: `Bearer ${credential}` } : {},
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = await limitedText(response);
  const text = contentType.includes("html") ? stripHtml(body) : body;
  return [{ title: source.name, text, url: source.url }];
}

async function loadGithub(source, credential) {
  const parsed = new URL(source.url);
  const parts = parsed.pathname.split("/").filter(Boolean);
  const offset = parsed.hostname === "api.github.com" && parts[0] === "repos" ? 1 : 0;
  const owner = parts[offset];
  const repo = parts[offset + 1]?.replace(/\.git$/, "");
  if (!owner || !repo) throw new Error("GitHub URL must identify an owner and repository");
  const headers = {
    accept: "application/vnd.github+json",
    ...(credential ? { authorization: `Bearer ${credential}` } : {}),
  };
  const repository = await jsonRequest(`https://api.github.com/repos/${owner}/${repo}`, { headers });
  const ref = String(source.config.ref ?? repository.default_branch ?? "main");
  const tree = await jsonRequest(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    { headers },
  );
  const extensions = source.config.extensions ?? [".md", ".txt", ".rst", ".adoc", ".json", ".yaml", ".yml"];
  const prefix = String(source.config.path_prefix ?? "");
  const maxFiles = Math.max(1, Math.min(500, Number(source.config.max_files) || 200));
  const files = (tree.tree ?? [])
    .filter((item) => item.type === "blob" && item.path.startsWith(prefix) && extensions.some((ext) => item.path.toLowerCase().endsWith(ext)))
    .slice(0, maxFiles);
  const documents = [];
  for (const file of files) {
    const blob = await jsonRequest(file.url, { headers });
    if (blob.encoding !== "base64") continue;
    const text = Buffer.from(blob.content, "base64").toString("utf8");
    documents.push({
      title: file.path,
      text,
      url: `https://github.com/${owner}/${repo}/blob/${encodeURIComponent(ref)}/${file.path}`,
    });
  }
  return documents;
}

async function loadNotion(source, credential) {
  if (!credential) throw new Error("Notion source requires a credential");
  const headers = {
    authorization: `Bearer ${credential}`,
    "content-type": "application/json",
    "notion-version": "2022-06-28",
  };
  const result = await jsonRequest("https://api.notion.com/v1/search", {
    method: "POST",
    headers,
    body: JSON.stringify({ page_size: Math.max(1, Math.min(100, Number(source.config.max_pages) || 50)) }),
  });
  const documents = [];
  for (const page of (result.results ?? []).filter((item) => item.object === "page")) {
    const blocks = await jsonRequest(`https://api.notion.com/v1/blocks/${page.id}/children?page_size=100`, { headers });
    const text = (blocks.results ?? []).flatMap(blockText).join("\n");
    const title = Object.values(page.properties ?? {}).flatMap((property) => property.title ?? []).map((item) => item.plain_text).join("") || page.id;
    documents.push({ title, text, url: page.url });
  }
  return documents;
}

async function loadConfluence(source, credential) {
  const base = source.url.replace(/\/$/, "");
  const params = new URLSearchParams({
    expand: "body.storage,version",
    limit: String(Math.max(1, Math.min(100, Number(source.config.max_pages) || 100))),
  });
  if (source.config.space_key) params.set("spaceKey", String(source.config.space_key));
  let authorization = "";
  if (credential && source.config.username) {
    authorization = `Basic ${Buffer.from(`${source.config.username}:${credential}`).toString("base64")}`;
  } else if (credential) authorization = `Bearer ${credential}`;
  const result = await jsonRequest(`${base}/rest/api/content?${params}`, {
    headers: authorization ? { authorization } : {},
  });
  return (result.results ?? []).map((page) => ({
    title: page.title,
    text: stripHtml(page.body?.storage?.value ?? ""),
    url: new URL(page._links?.webui ?? "", base).toString(),
  }));
}

function blockText(block) {
  const value = block[block.type];
  return (value?.rich_text ?? []).map((item) => item.plain_text ?? "");
}

function chunkDocument(source, document) {
  const text = String(document.text ?? "").replace(/\r\n/g, "\n").trim();
  const chunks = [];
  for (let start = 0; start < text.length; start += 1_300) {
    const value = text.slice(start, start + 1_500).trim();
    if (!value) continue;
    chunks.push({
      source_id: source.source_id,
      source_name: source.name,
      title: document.title,
      text: value,
      source: document.url,
      chunk: chunks.length,
      updated_at: new Date().toISOString(),
    });
  }
  return chunks;
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`knowledge request failed with HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_RESPONSE_BYTES) throw new Error("knowledge response exceeds 5 MiB");
  return response;
}

async function limitedText(response) {
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_RESPONSE_BYTES) throw new Error("knowledge response exceeds 5 MiB");
  return buffer.toString("utf8");
}

async function jsonRequest(url, options = {}) {
  const response = await request(url, options);
  return JSON.parse(await limitedText(response));
}

function stripHtml(value) {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
