/**
 * Recall: what the agent already knows, put in front of a session without it asking.
 *
 * Memory and knowledge are only worth keeping if a later session reads them, and a model
 * left to call `retrieve_memory` on its own mostly does not — it runs into a failure it
 * has already solved, reports it, and waits to be told the fix again. So every session
 * that does work is given two moments of recall it cannot skip:
 *
 *   before a task   `before_agent_start` searches memory and knowledge for the prompt
 *                   and attaches what it finds as a hidden note beside it.
 *   after an error  `tool_result` searches again for a failed tool's command and error
 *                   output, and appends what it finds to the result the model reads.
 *
 * Both are ordinary Pi extension hooks, registered inline by the runtime. A summary or a
 * compaction does not get them: that prompt is about one conversation, and recalled notes
 * from others would be written back into memory as if they had happened in it.
 *
 * The match is stricter than `retrieve_memory`'s. A prompt or an error is a lot of words,
 * most of them common, so a term counts for how rare it is across what is searched
 * (IDF), and an entry has to share several terms and clear a score before it is shown.
 * Nothing is shown twice while the model can still see it: a prompt skips what an earlier
 * recall note in the conversation's live context already carries, and an error skips what
 * was appended after an earlier error in the same run.
 * A recall that fails is logged and skipped — it can never take a prompt down with it.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const RECALL_TYPE = "zidane.recall";

const MAX_QUERY = 4_000;
const MAX_MEMORIES = 3;
const MAX_ARTICLES = 2;
const MAX_ENTRY = 2_400;
const MIN_TERMS = 2;
const MIN_SCORE = 3;

// A failure in the memory tools themselves is not a task failure worth recalling for.
const QUIET_TOOLS = new Set(["remember", "retrieve_memory", "forget_memory", "search_knowledge"]);

const STOPWORDS = new Set((
  "a an and are as at be been but by can could did do does done for from had has have how i if in "
  + "into is it its just let me more my no not of on or our please so than that the their them then "
  + "there these they this to up us use used using was we were what when where which who why will "
  + "with would you your yes ok okay command exited code"
).split(" "));

/** The distinct significant words of a text; a compound like `mstr-test-scripts` also yields its parts. */
export function terms(text) {
  const found = new Set();
  const add = (word) => {
    if (word.length >= 2 && !STOPWORDS.has(word) && !/^\d+$/.test(word)) found.add(word);
  };
  for (const word of String(text ?? "").toLowerCase().match(/[\p{L}\p{N}]+(?:[-_.][\p{L}\p{N}]+)*/gu) ?? []) {
    add(word);
    if (/[-_.]/.test(word)) for (const part of word.split(/[-_.]+/)) add(part);
  }
  return found;
}

/**
 * The items relevant to `text`, best first. Each term scores ln((N+1)/df), so a word every
 * entry contains is worth almost nothing and a word only one entry contains is worth most.
 */
export function rank(items, text, textOf) {
  const query = terms(text);
  if (!query.size || !items.length) return [];
  const documents = items.map((item, index) => ({ item, index, words: terms(textOf(item)) }));
  const frequency = new Map();
  for (const { words } of documents) {
    for (const word of words) if (query.has(word)) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  }
  const total = documents.length;
  return documents
    .map((document) => {
      let score = 0;
      let matched = 0;
      for (const word of query) {
        if (!document.words.has(word)) continue;
        matched += 1;
        score += Math.log((total + 1) / frequency.get(word));
      }
      return { ...document, score, matched };
    })
    .filter(({ score, matched }) => matched >= MIN_TERMS && score >= MIN_SCORE)
    // Ties go to the later entry, which for memory is the newer one.
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .map(({ item }) => item);
}

/** Memory and knowledge relevant to `text`, or null when nothing clears the bar. */
export async function recall({ memory, local }, text, exclude = new Set()) {
  const query = String(text ?? "");
  const memories = memory ? await memory.recall(query, MAX_MEMORIES, exclude) : [];
  // An article is indexed in chunks; the best-scoring chunk stands for it.
  const articles = [];
  for (const chunk of rank(await readIndex(local), query, (item) => `${item.title ?? ""} ${item.text ?? ""}`)) {
    const key = knowledgeKey(chunk);
    if (exclude.has(key) || articles.some((item) => knowledgeKey(item) === key)) continue;
    articles.push(chunk);
    if (articles.length >= MAX_ARTICLES) break;
  }
  return memories.length || articles.length ? { memories, articles } : null;
}

/** What the model reads: each entry with the id it needs to correct or forget it. */
export function recallText(found, lead) {
  const lines = [lead];
  for (const entry of found.memories) {
    const tags = entry.tags?.length ? `, tagged ${entry.tags.join(", ")}` : "";
    lines.push(`\n[memory ${entry.id}, saved ${new Date(entry.updated_at).toISOString().slice(0, 10)}${tags}]\n${clip(entry.text)}`);
  }
  for (const entry of found.articles) {
    lines.push(`\n[knowledge “${entry.title}”, ${entry.source_id}]\n${clip(entry.text)}`);
  }
  return lines.join("\n");
}

/** The standing instruction added to every working session's system prompt. */
export function recallGuidance(tools = []) {
  const has = (name) => !tools.length || tools.includes(name);
  const search = [has("retrieve_memory") && "`retrieve_memory`", has("search_knowledge") && "`search_knowledge`"]
    .filter(Boolean).join(" and ");
  return [
    "## What you already know",
    "",
    "Earlier sessions left you memory and knowledge: facts, fixes, and summaries of past work. They "
    + "only help if you use them.",
    "",
    "- Notes found for a request arrive beside it, marked as recalled; notes found for a failed "
    + "tool are appended to its result. Read them before acting. They are your own earlier notes: "
    + "if one records how a problem was solved, apply that fix instead of reporting the problem or "
    + "asking for help again, and say which note you followed. A note can be out of date; if one "
    + "turns out wrong, work it out and correct it.",
    ...(search ? [
      `- Before starting a task, search with ${search} for the task, system, repository, or skill `
      + "involved when nothing was recalled or what was recalled is not enough.",
      `- After a command or tool fails, search with ${search} for the error before you report it `
      + "or ask the person — the same failure may already have been solved.",
    ] : []),
  ].join("\n");
}

/**
 * The inline Pi extension that does the recalling for one session.
 *
 * Made per session, so "already shown after an error" is remembered for exactly as long
 * as the session that was shown it.
 */
export function recallExtension({ memory, local, logger }) {
  const surfaced = new Set();
  const attempt = async (moment, text, exclude) => {
    try {
      return await recall({ memory, local }, text, exclude);
    } catch (error) {
      logger?.log("warning", "recall skipped", { moment, error: String(error) });
      return null;
    }
  };
  return {
    name: "zidane-recall",
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", async (event, context) => {
        const found = await attempt("prompt", String(event.prompt ?? "").slice(0, MAX_QUERY), inContext(context));
        if (!found) return undefined;
        const ids = identifiers(found);
        logger?.log("info", "recalled for prompt", { ids });
        return {
          message: {
            customType: RECALL_TYPE,
            content: recallText(found, "Recalled from your memory and knowledge because it may bear on this request:"),
            display: false,
            details: { ids },
          },
        };
      });
      pi.on("tool_result", async (event) => {
        if (!event.isError || QUIET_TOOLS.has(event.toolName)) return undefined;
        const output = (event.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
        const query = `${describeInput(event.input)}\n${output.slice(-MAX_QUERY)}`;
        const found = await attempt("error", query, surfaced);
        if (!found) return undefined;
        const ids = identifiers(found);
        for (const id of ids) surfaced.add(id);
        logger?.log("info", "recalled for error", { tool: event.toolName, ids });
        return {
          content: [
            ...(event.content ?? []),
            { type: "text", text: recallText(found, `\n---\nRecalled from your memory and knowledge because this ${event.toolName} call failed — check whether it was solved before:`) },
          ],
        };
      });
    },
  };
}

/** The knowledge index `search_knowledge` reads; empty when there is none yet. */
export async function readIndex(local) {
  try {
    const value = JSON.parse(await readFile(resolve(local.knowledge, "index.json"), "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/** Ids an earlier recall note in this conversation already put in front of the model. */
function inContext(context) {
  const shown = new Set();
  let entries = [];
  try { entries = context?.sessionManager?.buildContextEntries?.() ?? []; } catch { return shown; }
  for (const entry of entries) {
    if (entry.type !== "custom_message" || entry.customType !== RECALL_TYPE) continue;
    for (const id of entry.details?.ids ?? []) shown.add(id);
  }
  return shown;
}

function describeInput(input) {
  if (!input || typeof input !== "object") return "";
  if (typeof input.command === "string") return input.command.slice(0, 1_000);
  if (typeof input.path === "string") return input.path;
  try { return JSON.stringify(input).slice(0, 1_000); } catch { return ""; }
}

function identifiers(found) {
  return [...found.memories.map((entry) => entry.id), ...found.articles.map(knowledgeKey)];
}

function knowledgeKey(chunk) {
  return `knowledge:${chunk.source_id}`;
}

function clip(text) {
  const value = String(text ?? "").trim();
  return value.length > MAX_ENTRY ? `${value.slice(0, MAX_ENTRY)}…` : value;
}
