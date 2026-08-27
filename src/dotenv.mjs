/**
 * `config-maps/.env` — where a config map's secret values live.
 *
 * A config map declares the names of its secret values; the values themselves are
 * never part of the record. They are read from the process environment, and this file
 * is how a value that was not passed in through the container's environment gets
 * there: it is merged into `process.env` at startup, and an existing environment
 * variable always wins, so a deployment can override anything on disk.
 */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const ENV_FILE = ".env";
export const SAFE_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function envPath(local) {
  return resolve(local.configMaps, ENV_FILE);
}

/** Parse `KEY=value` lines. Quotes are stripped; anything malformed is skipped. */
export function parseEnv(text) {
  const values = {};
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim().replace(/^export\s+/, "");
    if (!SAFE_ENV_KEY.test(key)) continue;
    let value = line.slice(separator + 1).trim();
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function formatEnv(values) {
  const lines = ["# Secret values for this agent's config maps. Managed by Zidane; an", "# environment variable of the same name takes precedence over anything here.", ""];
  for (const key of Object.keys(values).sort()) {
    lines.push(`${key}=${JSON.stringify(String(values[key]))}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function readEnvFile(local) {
  try { return parseEnv(await readFile(envPath(local), "utf8")); } catch { return {}; }
}

export async function writeEnvFile(local, values) {
  const target = envPath(local);
  await mkdir(dirname(target), { recursive: true });
  const pending = `${target}.new`;
  await writeFile(pending, formatEnv(values), { mode: 0o600 });
  await rename(pending, target);
  await chmod(target, 0o600);
}

/**
 * Merge the file into `process.env` without displacing anything already set.
 *
 * Returns the keys it supplied, so a caller can tell which secret values came from
 * disk rather than from the deployment.
 */
export async function loadEnvFile(local) {
  const supplied = [];
  for (const [key, value] of Object.entries(await readEnvFile(local))) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      supplied.push(key);
    }
  }
  return supplied.sort();
}
