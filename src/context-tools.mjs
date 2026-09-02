import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MAX_MINUTES, MIN_MINUTES } from "./follow-up.mjs";

export function contextTools(local, memory, data, session = {}) {
  const { conversation = "", followUps = null, knowledge = null } = session;
  return [
    // A conversation can ask to be woken later. Only where there is a conversation to
    // wake: a summary or a compaction has nowhere to come back to.
    ...(followUps && conversation ? [defineTool({
      name: "check_back",
      label: "Check back later",
      description:
        "Come back to this conversation later, once. Use it whenever something you started or were "
        + "asked to watch will not be done for a while — a build, a deployment, a long import, a test "
        + "run — including when the person simply asks you to watch something and tell them how it "
        + "goes. Nothing else in this system polls anything: if you do not call this, nobody comes "
        + "back, and the person is left waiting for a message that will never arrive. "
        + "The note is the entire instruction to your future self, so put the link, the job id, or the "
        + "command in it, and say how to tell finished from failed — by then this conversation may "
        + "have been summarised and the note may be all you have. "
        + "When it wakes you, either report the outcome or call this again to look later; calling it "
        + "again replaces the pending check rather than adding a second one. "
        + "Choose the interval from how long the thing takes: a few minutes for something that should "
        + "be done within the hour, fifteen to thirty for a long build or deployment, an hour for "
        + "something that runs overnight. Checking every minute for something that takes hours only "
        + "spends the watch — it stops after 120 checks or 24 hours, whichever comes first. If the "
        + "person named an interval, use theirs.",
      parameters: Type.Object({
        minutes: Type.Integer({ minimum: MIN_MINUTES, maximum: MAX_MINUTES }),
        note: Type.String({ minLength: 1, maxLength: 2_000 }),
      }),
      execute: async (_id, args) => {
        const record = await followUps.arm({ conversation, note: args.note, minutes: args.minutes });
        const at = new Date(record.due_at).toISOString().slice(11, 16);
        return text(
          `Will check back in ${record.minutes} minute${record.minutes === 1 ? "" : "s"} (about ${at} UTC). `
          + "Say what you are waiting on before you finish this turn — the person is watching this "
          + "conversation and only sees what you write here.",
          { due_at: record.due_at, attempts: record.attempts },
        );
      },
    })] : []),
    ...(followUps && conversation ? [defineTool({
      name: "stop_checking",
      label: "Stop checking back",
      description:
        "Cancel the pending check-back for this conversation. Use it when the thing you were watching "
        + "has finished, when the person asks you to stop, or when waiting any longer cannot help.",
      parameters: Type.Object({}),
      execute: async () => {
        const had = await followUps.cancel(conversation);
        return text(had ? "Stopped checking back on this conversation." : "There was no check-back pending.");
      },
    })] : []),
    ...(data ? [defineTool({
      name: "draft_skill",
      label: "Draft skill",
      description:
        "Save what this session worked out as a reusable skill in this agent's own skill library, "
        + "so a later session can follow it instead of working it out again. Use it for a task worth "
        + "repeating: say when the skill applies, then the steps. Saving a name that already exists "
        + "replaces that skill. Never put a credential in one.",
      parameters: Type.Object({
        name: Type.String({ minLength: 1, maxLength: 120 }),
        description: Type.String({ minLength: 1, maxLength: 1_024 }),
        instructions: Type.String({ minLength: 1, maxLength: 200_000 }),
      }),
      execute: async (_id, args) => {
        const name = args.name.trim();
        // The same serialised store the REST relay writes through, so a skill saved from
        // a session cannot interleave with one being edited from the browser.
        const existing = (await data.handle("skill.list")).items
          .find((item) => String(item.name).toLowerCase() === name.toLowerCase());
        const content = skillMarkdown(name, args.description, args.instructions);
        const result = existing
          ? await data.handle("skill.update", { skill_id: existing.skill_id, name, content })
          : await data.handle("skill.create", { name, content });
        return text(`${existing ? "Replaced" : "Saved"} the skill ${result.item.name}. It loads in new sessions.`, {
          skill_id: result.item.skill_id,
          replaced: Boolean(existing),
        });
      },
    })] : []),
    ...(knowledge ? [defineTool({
      name: "draft_knowledge",
      label: "Draft knowledge article",
      description:
        "Write what this session learned into this agent's own knowledge library, as an article that "
        + "`search_knowledge` finds in every later session and every conversation. Use it for durable "
        + "reference material — how a system is laid out, what an interface expects, a decision and the "
        + "reason for it — where `draft_skill` is for a procedure worth repeating and `remember` is for a "
        + "short fact. Write it for somebody who was not in this conversation: say what the thing is "
        + "before what was done to it. Saving a title that already exists replaces that article. "
        + "This is the agent's own copy — it is not shared with the account, and an account article is "
        + "never overwritten by it. Never put a credential in one.",
      parameters: Type.Object({
        name: Type.String({ minLength: 1, maxLength: 200 }),
        description: Type.String({ minLength: 1, maxLength: 2_000 }),
        content: Type.String({ minLength: 1, maxLength: 200_000 }),
        tags: Type.Optional(Type.Array(Type.String({ maxLength: 80 }), { maxItems: 20 })),
      }),
      execute: async (_id, args) => {
        const record = await knowledge.note(args);
        return text(
          `${record.replaced ? "Replaced" : "Saved"} the knowledge article “${record.name}”. `
          + "Later sessions find it with search_knowledge. It stays on this agent — promote it from the "
          + "console if the account should have it.",
          { id: record.id, replaced: record.replaced },
        );
      },
    })] : []),
    defineTool({
      name: "remember",
      label: "Remember",
      description: "Store durable, relevant non-secret information for future sessions.",
      parameters: Type.Object({
        text: Type.String({ minLength: 1, maxLength: 10_000 }),
        tags: Type.Optional(Type.Array(Type.String({ maxLength: 80 }), { maxItems: 20 })),
        sensitivity: Type.Optional(
          Type.Union([Type.Literal("normal"), Type.Literal("private"), Type.Literal("restricted")]),
        ),
        ttl_days: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })),
      }),
      execute: async (_id, args) => {
        const entry = await memory.add(args, "agent");
        return text(`Stored memory ${entry.id}.`, { id: entry.id });
      },
    }),
    defineTool({
      name: "retrieve_memory",
      label: "Retrieve memory",
      description: "Retrieve relevant non-restricted durable memories with memory IDs.",
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 1_000 }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      }),
      execute: async (_id, args) => {
        const matches = await memory.query(args.query, args.limit ?? 5, false);
        return text(matches.length ? JSON.stringify(matches) : "No relevant memory found.", {
          count: matches.length,
        });
      },
    }),
    defineTool({
      name: "forget_memory",
      label: "Forget memory",
      description: "Permanently delete a memory when asked or when it is no longer valid.",
      parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
      execute: async (_id, args) =>
        text((await memory.delete(args.id)) ? "Memory removed." : "Memory not found.", {}),
    }),
    defineTool({
      name: "search_knowledge",
      label: "Search knowledge",
      description: "Search indexed knowledge sources and return cited snippets.",
      parameters: Type.Object({
        query: Type.String({ minLength: 1 }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      }),
      execute: async (_id, args) => {
        const index = await loadIndex(local);
        const terms = tokens(args.query);
        const matches = index
          .map((item) => ({ item, score: score(`${item.title ?? ""} ${item.text ?? ""}`, terms) }))
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, args.limit ?? 5)
          .map(({ item }) => ({
            source_id: item.source_id,
            title: item.title,
            snippet: String(item.text ?? "").slice(0, 1_200),
            source: item.source,
            chunk: item.chunk,
            updated_at: item.updated_at,
          }));
        return text(matches.length ? JSON.stringify(matches) : "No matching knowledge found.", {
          count: matches.length,
        });
      },
    }),
  ];
}

/**
 * A SKILL.md the loader will accept.
 *
 * Pi parses this block as real YAML and skips a skill whose description is missing, so
 * the model supplies the two fields and the file is assembled here — a body written
 * straight to disk would be a skill that silently never loads.
 */
function skillMarkdown(name, description, instructions) {
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "skill";
  return `---\nname: ${yamlScalar(slug)}\ndescription: ${yamlScalar(description)}\n---\n\n${instructions.trim()}\n`;
}

/** Plain where it can be read as plain, quoted where YAML would read it as structure. */
function yamlScalar(value) {
  const flat = String(value).replace(/\s+/g, " ").trim();
  return /^[A-Za-z0-9][A-Za-z0-9 ._,'()/-]*$/.test(flat) ? flat : JSON.stringify(flat);
}

async function loadIndex(local) {
  try {
    const value = JSON.parse(await readFile(resolve(local.knowledge, "index.json"), "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function tokens(input) {
  return String(input).toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
}

function score(input, terms) {
  const source = input.toLowerCase();
  return terms.reduce((sum, term) => sum + (source.includes(term) ? 1 : 0), 0);
}

function text(value, details) {
  return { content: [{ type: "text", text: value }], details };
}
