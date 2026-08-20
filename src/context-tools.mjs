import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export function contextTools(local, memory) {
  return [
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
