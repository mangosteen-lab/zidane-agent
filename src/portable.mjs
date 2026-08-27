import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import * as tar from "tar";

const ROOTS = ["agent.json", "SOUL.md", "skills", "memory", "knowledge", "config", "config-maps", "crontab"];
// `config-maps` travels, but the secret values seeded into the environment from
// `config-maps/.env` never do: a portable archive carries configuration, not credentials.
const EXCLUDED = new Set(["config-maps/.env"]);
const MAX_FILE_BYTES = 50 * 1024 * 1024;

export async function exportAgent(local, filename) {
  const files = [];
  for (const root of ROOTS) await collect(resolve(local.root, root), local.root, files);
  const manifest = { format_version: 1, files };
  const manifestPath = resolve(local.root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: "wx" });
  const archive = resolve(local.exports, filename);
  try {
    await tar.create({ gzip: true, cwd: local.root, file: archive }, [...files.map((f) => f.path), "manifest.json"]);
  } finally {
    await rm(manifestPath, { force: true });
  }
  return { archive, manifest };
}

export async function validateArchive(archive) {
  const entries = [];
  await tar.list({ file: archive, onentry: (entry) => entries.push({ path: entry.path, type: entry.type }) });
  if (entries.some((entry) => unsafe(entry.path) || !["File", "Directory"].includes(entry.type))) throw new Error("archive contains an unsafe entry");
  return entries;
}

export async function importAgent(local, archive, mode = "validate") {
  const entries = await validateArchive(archive);
  const paths = new Set(entries.map((entry) => entry.path));
  if (!paths.has("manifest.json")) throw new Error("archive has no manifest");
  const stage = resolve(local.root, `.import-${Date.now()}`);
  await mkdir(stage, { recursive: true });
  try {
    await tar.extract({ file: archive, cwd: stage, preservePaths: false });
    const manifest = JSON.parse(await readFile(resolve(stage, "manifest.json"), "utf8"));
    for (const item of manifest.files ?? []) {
      if (unsafe(item.path) || EXCLUDED.has(item.path) || !ROOTS.some((root) => item.path === root || item.path.startsWith(`${root}/`))) throw new Error(`invalid manifest path: ${item.path}`);
      const data = await readFile(resolve(stage, item.path));
      if (createHash("sha256").update(data).digest("hex") !== item.sha256) throw new Error(`checksum mismatch: ${item.path}`);
    }
    if (mode === "validate") return { status: "validated", files: manifest.files?.length ?? 0 };
    if (!new Set(["merge", "replace"]).has(mode)) throw new Error("mode must be validate, merge, or replace");
    const targets = ROOTS.filter((item) => item !== "agent.json");
    if (mode === "replace") for (const target of targets) await rm(resolve(local.root, target), { recursive: true, force: true });
    for (const target of ROOTS) {
      const source = resolve(stage, target); let info; try { info = await stat(source); } catch { continue; }
      await cp(source, resolve(local.root, target), { recursive: info.isDirectory(), force: mode === "replace", errorOnExist: false });
    }
    return { status: "imported", mode, files: manifest.files?.length ?? 0 };
  } finally { await rm(stage, { recursive: true, force: true }); }
}

async function collect(path, root, files) {
  let info; try { info = await stat(path); } catch { return; }
  if (info.isDirectory()) { for (const name of await readdir(path)) await collect(resolve(path, name), root, files); return; }
  if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error(`unsafe export entry: ${path}`);
  const relativePath = relative(root, path).split("\\").join("/");
  if (EXCLUDED.has(relativePath)) return;
  const data = await readFile(path);
  files.push({ path: relativePath, sha256: createHash("sha256").update(data).digest("hex"), size: info.size });
}
function unsafe(path) { return path.startsWith("/") || path.split(/[\\/]/).includes(".."); }
