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

/** True when a quoted value is closed — the quote not cancelled by a backslash. */
function closedQuote(raw, quote) {
  if (raw.length < 2 || !raw.endsWith(quote)) return false;
  let slashes = 0;
  for (let at = raw.length - 2; at >= 0 && raw[at] === "\\"; at -= 1) slashes += 1;
  return slashes % 2 === 0;
}

/**
 * Turn the stored form back into the value.
 *
 * A double-quoted value is what `formatEnv` writes, and `JSON.parse` inverts it
 * exactly — including the `\n` that an SSH key or a PEM certificate is full of. That
 * used to be dropped: the quotes came off and the escape did not, so a multi-line
 * secret arrived as one line with a literal backslash-n in it and failed much later,
 * nowhere near the cause.
 *
 * A hand-written file is not JSON and must not be made to answer for that, so anything
 * `JSON.parse` refuses — `"C:\path"`, or real newlines inside the quotes — falls back
 * to the text between the quotes, unchanged. Single quotes never unescape, which is the
 * convention everywhere else and the way to store a value containing backslashes.
 */
function decodeValue(raw, quote) {
  if (!quote) return raw;
  if (quote === '"') {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "string") return parsed;
    } catch { /* hand-written, not something this wrote */ }
  }
  return raw.slice(1, closedQuote(raw, quote) ? -1 : undefined);
}

/**
 * Parse `KEY=value` lines.
 *
 * A quoted value may span physical lines, so a key pasted into the file by hand keeps
 * its newlines. Anything malformed is skipped rather than throwing: this file is seeded
 * by deployments, and one bad line must not cost an agent every other value in it.
 */
export function parseEnv(text) {
  const values = {};
  const lines = String(text ?? "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim().replace(/^export\s+/, "");
    if (!SAFE_ENV_KEY.test(key)) continue;
    let raw = line.slice(separator + 1).trim();
    const quote = raw[0] === '"' || raw[0] === "'" ? raw[0] : "";
    // Gather continuation lines until the quote closes. An unterminated one stops at the
    // end of the file rather than swallowing the keys below it.
    while (quote && !closedQuote(raw, quote) && index + 1 < lines.length) {
      index += 1;
      raw += `\n${lines[index]}`;
    }
    values[key] = decodeValue(raw, quote);
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
