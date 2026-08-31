/**
 * `$skill` commands.
 *
 * A message may open with `$name args…`, which means "do this with that skill". It is
 * the one piece of syntax the chat box has, and it exists because naming the skill is
 * often the whole instruction: `$pr-fill https://github.com/owner/repo/pull/13764`.
 *
 * Resolution happens **here, on the agent**, for the same reason skills live here: the
 * control plane never reads a skill and has no idea which ones are installed. The
 * message is stored as the person typed it, so a transcript still shows the command;
 * only the prompt handed to Pi is rewritten.
 *
 * A `$word` that names no installed skill is left exactly as it was typed. `$HOME`,
 * `$5`, and a stray dollar in a shell snippet are ordinary text, and silently mangling
 * them would be worse than not resolving a typo.
 */

import { resolve } from "node:path";
import { discoverSkills } from "./agent-data.mjs";

/** `$name`, then the rest of that line, then whatever follows on later lines. */
const COMMAND = /^[ \t]*\$([A-Za-z][A-Za-z0-9._-]*)[ \t]*([^\n]*)(?:\n([\s\S]*))?$/;

/** True when the text is worth resolving at all, so the common message never walks disk. */
export function looksLikeCommand(text) {
  return COMMAND.test(String(text ?? ""));
}

export function parseCommand(text) {
  const match = COMMAND.exec(String(text ?? ""));
  if (!match) return null;
  return {
    name: match[1],
    argument: (match[2] ?? "").trim(),
    body: (match[3] ?? "").trim(),
  };
}

/** `PR_Fill` and `pr-fill` are the same skill; nothing else is. */
function normalise(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
}

export function matchSkill(name, skills) {
  const wanted = normalise(name);
  return skills.find((skill) => normalise(skill.name) === wanted)
    ?? skills.find((skill) => normalise(skill.directory?.split("/").pop()) === wanted)
    ?? null;
}

/**
 * The prompt a named skill turns into.
 *
 * It points at the file rather than inlining it: the session already has the skills
 * directory on its resource path, `read` is not confined to the workspace, and a long
 * SKILL.md pasted into every prompt is tokens spent before the work starts. Every other
 * installed skill stays available — a skill that leans on another one still works.
 */
export function commandPrompt(skill, { argument, body }) {
  const lines = [
    `Use the \`${skill.name}\` skill for this task, and follow it.`,
    `Its instructions are in ${resolve(skill.directory, "SKILL.md")} — read that file first.`,
  ];
  if (argument) lines.push(`Input: ${argument}`);
  if (body) lines.push("", body);
  return lines.join("\n");
}

/**
 * Rewrite a prompt that opens with a `$skill` command.
 *
 * Returns what to send and which skill it named, so a caller can log it. Anything that
 * is not a command, or names a skill this agent does not have, comes back untouched.
 */
export async function expandCommand(text, skillRoot) {
  const parsed = parseCommand(text);
  if (!parsed) return { text, skill: null, unknown: null };
  let skills = [];
  try { skills = await discoverSkills(skillRoot); }
  catch { return { text, skill: null, unknown: null }; }
  const skill = matchSkill(parsed.name, skills);
  if (!skill) return { text, skill: null, unknown: parsed.name };
  return { text: commandPrompt(skill, parsed), skill: skill.name, unknown: null };
}
