import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export function contextTools(local, memory, data) {
  return [
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
