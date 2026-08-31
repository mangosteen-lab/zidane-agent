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
 *
 * A couple of commands are built in rather than being skills, because they drive the
 * agent's own machinery rather than describing work: `$watch` and `$unwatch` are how a
 * person starts and stops a follow-up by hand, with the interval they want rather than
 * the one the model would have chosen. They are checked before the skills, so the names
 * mean the same thing on every agent.
 */

import { resolve } from "node:path";
import { discoverSkills } from "./agent-data.mjs";
import { MAX_MINUTES, MIN_MINUTES } from "./follow-up.mjs";

/** What `$watch` uses when the person did not say how often. */
export const DEFAULT_WATCH_MINUTES = 10;

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
 * The commands that are not skills.
 *
 * Each turns the command line into an instruction naming the tool to call. Saying it in
 * words works too — this is the version that does not depend on the model reading the
 * room, and it is where a person's own interval gets to be the one that is used.
 */
export const BUILT_INS = {
  watch: {
    description: "Check back on something every few minutes until it is done, then report",
    usage: "$watch [minutes] <what to watch>",
    expand: ({ argument, body }) => {
      // `$watch 15 the build at …`, or `$watch the build at …` for the default.
      const [, spoken, rest] = /^(\d{1,4})?\s*([\s\S]*)$/.exec(argument) ?? [];
      // A number they typed is a number they meant, clamped into range. Only its absence
      // is unspecified — `$watch 0` is not a request for the default.
      const minutes = spoken === undefined
        ? DEFAULT_WATCH_MINUTES
        : Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Number(spoken)));
      const what = [rest, body].filter(Boolean).join("\n\n").trim();
      return [
        "The person has asked you to watch something and tell them how it goes.",
        "",
        `How often to check: every ${minutes} minutes. This is what they asked for — keep to it`,
        "unless there is a reason to change it, and say so if you do.",
        "",
        what ? `What to watch: ${what}` : "What to watch: whatever this conversation was just about.",
        "",
        `Call check_back with minutes: ${minutes} and a note carrying everything needed to look`,
        "again — the link, the job id, or the command, and how to tell finished from failed.",
        "Then say here what you are waiting on. When it wakes you, keep checking at that",
        "interval until it has finished or failed, report the outcome, and stop.",
      ].join("\n");
    },
  },
  unwatch: {
    description: "Stop the check-back running on this conversation",
    usage: "$unwatch",
    expand: () => [
      "The person has asked you to stop watching whatever this conversation was following.",
      "Call stop_checking, then confirm in one line that you have stopped and say where",
      "things stood when you last looked.",
    ].join("\n"),
  },
};

/**
 * Rewrite a prompt that opens with a `$skill` command.
 *
 * Returns what to send and which skill it named, so a caller can log it. Anything that
 * is not a command, or names a skill this agent does not have, comes back untouched.
 */
export async function expandCommand(text, skillRoot) {
  const parsed = parseCommand(text);
  if (!parsed) return { text, skill: null, unknown: null };
  // Built in first: these name the agent's own machinery, and a skill that happened to
  // be called `watch` must not quietly change what `$watch` does on one agent.
  const builtIn = BUILT_INS[parsed.name.toLowerCase()];
  if (builtIn) return { text: builtIn.expand(parsed), skill: `$${parsed.name.toLowerCase()}`, unknown: null };
  let skills = [];
  try { skills = await discoverSkills(skillRoot); }
  catch { return { text, skill: null, unknown: null }; }
  const skill = matchSkill(parsed.name, skills);
  if (!skill) return { text, skill: null, unknown: parsed.name };
  return { text: commandPrompt(skill, parsed), skill: skill.name, unknown: null };
}
