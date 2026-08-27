/**
 * Knowledge articles held on the agent, and the index the `search_knowledge` tool reads.
 *
 * Articles are authored on the account and synced down; the agent never fetches
 * anything itself. On disk each article is a directory named by its id, holding one
 * markdown file and whatever images it references:
 *
 *   knowledge/articles/<id>/<Name>.md
 *   knowledge/articles/<id>/image.png
 *
 * The hierarchy lives in each article's `parent_id`, not in the directory layout —
 * the agent only ever searches, so nesting would buy it nothing. The repository
 * format that mirrors the tree is the control plane's concern.
 */

import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const MAX_CONTENT_BYTES = 1_000_000;
const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const CHUNK_STRIDE = 1_300;
const CHUNK_SIZE = 1_500;

export class KnowledgeStore {
  constructor(local, logger) {
    this.local = local;
    this.logger = logger;
    this.articles = resolve(local.knowledge, "articles");
  }

  async start() {
    await mkdir(this.articles, { recursive: true });
    await this.#rebuildIndex();
  }

  /** Replace the synced set wholesale: what the account shares is what the agent holds. */
  async apply(incoming) {
    const wanted = new Map();
    for (const raw of Array.isArray(incoming) ? incoming : []) {
      const article = validArticle(raw);
      wanted.set(article.id, article);
    }
    await mkdir(this.articles, { recursive: true });
    for (const entry of await readdir(this.articles, { withFileTypes: true })) {
      if (entry.isDirectory() && !wanted.has(entry.name)) {
        await rm(resolve(this.articles, entry.name), { recursive: true, force: true });
      }
    }
    for (const article of wanted.values()) await this.#write(article);
    await this.#rebuildIndex();
    return { count: wanted.size };
  }

  async #write(article) {
    const directory = resolve(this.articles, article.id);
    if (dirname(directory) !== this.articles) throw new Error("article path escapes the store");
    // Rewritten from scratch: a rename or a dropped image would otherwise linger.
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, `${article.file}.md`), articleMarkdown(article));
    for (const asset of article.assets) {
      const target = resolve(directory, asset.name);
      if (dirname(target) !== directory) throw new Error("asset path escapes the article");
      await writeFile(target, Buffer.from(asset.data, "base64"));
    }
  }

  async #rebuildIndex() {
    const index = [];
    let entries = [];
    try { entries = await readdir(this.articles, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
      const directory = resolve(this.articles, entry.name);
      const file = (await readdir(directory)).find((name) => name.endsWith(".md"));
      if (!file) continue;
      try {
        const article = parseArticle(await readFile(resolve(directory, file), "utf8"), entry.name);
        index.push(...chunk(article));
      } catch (error) {
        this.logger?.log("warning", "knowledge article is unreadable", { id: entry.name, error: String(error) });
      }
    }
    const destination = resolve(this.local.knowledge, "index.json");
    const pending = `${destination}.new`;
    await writeFile(pending, JSON.stringify(index, null, 2), { mode: 0o600 });
    await rename(pending, destination);
    await chmod(destination, 0o600);
    return index.length;
  }
}

/** `<Name>.md` is frontmatter plus markdown, the same shape the repository uses. */
export function articleMarkdown(article) {
  const tags = article.tags.length ? `\ntags: [${article.tags.join(", ")}]` : "";
  const parent = article.parent_id ? `\nparent_id: ${article.parent_id}` : "";
  return `---\nid: ${article.id}\nname: ${article.name}\ndescription: ${article.description}${tags}${parent}\n---\n${article.content}`;
}

export function parseArticle(raw, fallbackId) {
  const match = /^---\s*\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(String(raw ?? ""));
  if (!match) return { id: fallbackId, name: fallbackId, description: "", tags: [], parent_id: null, content: String(raw ?? "") };
  const meta = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    meta[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  const tags = /^\[(.*)\]$/.exec(meta.tags ?? "");
  return {
    id: SAFE_ID.test(meta.id ?? "") ? meta.id : fallbackId,
    // The repository in the wild uses `name` on some articles and `title` on others.
    name: meta.name || meta.title || fallbackId,
    description: meta.description ?? "",
    tags: tags ? tags[1].split(",").map((tag) => tag.trim()).filter(Boolean) : [],
    parent_id: SAFE_ID.test(meta.parent_id ?? "") ? meta.parent_id : null,
    content: match[2],
  };
}

function validArticle(raw) {
  const id = String(raw?.id ?? "");
  if (!SAFE_ID.test(id)) throw new Error(`unsafe knowledge id: ${id}`);
  const content = String(raw.content ?? "");
  if (Buffer.byteLength(content) > MAX_CONTENT_BYTES) throw new Error(`knowledge article ${id} is too large`);
  const assets = [];
  for (const asset of Array.isArray(raw.assets) ? raw.assets : []) {
    const name = String(asset?.name ?? "");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(name) || name.endsWith(".md")) {
      throw new Error(`unsafe knowledge asset name: ${name}`);
    }
    const data = String(asset.data ?? "");
    if (Buffer.byteLength(data, "base64") > MAX_ASSET_BYTES) throw new Error(`knowledge asset ${name} is too large`);
    assets.push({ name, data });
  }
  return {
    id,
    name: String(raw.name ?? id).slice(0, 200),
    file: slug(String(raw.name ?? id)),
    description: String(raw.description ?? "").slice(0, 2_000),
    tags: (Array.isArray(raw.tags) ? raw.tags : []).map((tag) => String(tag).trim()).filter(Boolean).slice(0, 50),
    parent_id: SAFE_ID.test(String(raw.parent_id ?? "")) ? String(raw.parent_id) : null,
    content,
    assets,
  };
}

/** Same chunk shape the index has always held, so `search_knowledge` is unchanged. */
function chunk(article) {
  const text = article.content.replace(/\r\n/g, "\n").trim();
  const chunks = [];
  for (let start = 0; start < text.length; start += CHUNK_STRIDE) {
    const value = text.slice(start, start + CHUNK_SIZE).trim();
    if (!value) continue;
    chunks.push({
      source_id: article.id,
      source_name: article.name,
      title: article.name,
      text: value,
      source: article.description,
      chunk: chunks.length,
      updated_at: new Date().toISOString(),
    });
  }
  if (!chunks.length && article.name) {
    // A title-only article is still worth finding.
    chunks.push({ source_id: article.id, source_name: article.name, title: article.name, text: article.description, source: article.description, chunk: 0, updated_at: new Date().toISOString() });
  }
  return chunks;
}

export function slug(value) {
  const cleaned = String(value).trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return cleaned || "article";
}
