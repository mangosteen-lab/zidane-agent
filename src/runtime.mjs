import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { readSecret } from "./config.mjs";
import { contextTools } from "./context-tools.mjs";

export class PiRuntime {
  #active = new Map();
  constructor(config, local, emit, logger, memory) { this.config = config; this.local = local; this.emit = emit; this.logger = logger; this.memory = memory; }
  get active() { return this.#active.size; }

  prompt(delivery) {
    if (this.active >= this.config.capacity) throw new Error("at capacity");
    if (this.#active.has(delivery.delivery_id)) return;
    const entry = { session: null, cancelled: false, task: null };
    const task = this.#run(delivery, entry)
      .catch((error) => this.emit("PROMPT_DONE", {
        delivery_id: delivery.delivery_id, conversation_id: delivery.conversation_id,
        status: "error", error: String(error),
      }))
      .finally(() => this.#active.delete(delivery.delivery_id));
    entry.task = task;
    this.#active.set(delivery.delivery_id, entry);
    return task;
  }

  cancel(deliveryId) {
    const entry = this.#active.get(deliveryId);
    if (!entry) return false;
    entry.cancelled = true;
    void entry.session?.abort();
    return true;
  }

  async #run(delivery, entry) {
    this.logger?.log("info", "prompt started", { delivery_id: delivery.delivery_id, conversation_id: delivery.conversation_id });
    const conversation = safeName(delivery.conversation_id ?? delivery.delivery_id);
    const workspace = resolve(this.local.workspaces, conversation);
    await mkdir(workspace, { recursive: true });
    let profile = delivery.profile ?? {};
    if (!profile.provider) {
      try { profile = JSON.parse(await readFile(resolve(this.local.config, "default-llm-profile.json"), "utf8")); }
      catch { profile = {}; }
    }
    const runtime = await ModelRuntime.create({ authPath: resolve(this.local.secrets, "pi-auth.json"), modelsPath: resolve(this.local.config, "models.json") });
    if (profile.provider && profile.secret_name) {
      await runtime.setRuntimeApiKey(profile.provider, await readSecret(this.local, profile.secret_name));
    }
    const soul = await readFile(this.local.soul, "utf8");
    const loader = new DefaultResourceLoader({
      cwd: workspace,
      agentDir: this.local.root,
      systemPromptOverride: () => soul,
      additionalSkillPaths: [this.local.skills],
    });
    await loader.reload();
    const model = profile.provider && profile.model ? runtime.getModel(profile.provider, profile.model) : undefined;
    if (profile.provider && profile.model && !model) throw new Error(`unknown Pi model: ${profile.provider}/${profile.model}`);
    const { session } = await createAgentSession({
      cwd: workspace,
      sessionManager: SessionManager.continueRecent(workspace, this.local.sessions),
      agentDir: this.local.root,
      model,
      thinkingLevel: profile.thinking_level ?? "medium",
      modelRuntime: runtime,
      resourceLoader: loader,
      tools: profile.tools?.length ? profile.tools : ["read", "grep", "find", "ls", "write", "edit", "bash", "remember", "retrieve_memory", "forget_memory", "search_knowledge"],
      customTools: contextTools(this.local, this.memory),
    });
    entry.session = session;
    if (entry.cancelled) await session.abort();
    const transcript = [];
    let responseText = "";
    session.subscribe((event) => {
      const item = sanitise(event);
      transcript.push(item);
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        responseText += event.assistantMessageEvent.delta;
        this.emit("PROMPT_EVENT", { delivery_id: delivery.delivery_id, conversation_id: delivery.conversation_id, event: "text", text: event.assistantMessageEvent.delta });
      } else if (event.type.includes("tool")) {
        this.emit("PROMPT_EVENT", { delivery_id: delivery.delivery_id, conversation_id: delivery.conversation_id, event: "tool", detail: item });
      }
    });
    try {
      await session.prompt(delivery.text);
      await writeFile(resolve(this.local.sessions, `${conversation}.json`), JSON.stringify(transcript));
      this.emit("PROMPT_DONE", { delivery_id: delivery.delivery_id, conversation_id: delivery.conversation_id, status: entry.cancelled ? "cancelled" : "completed", final_text: responseText.slice(0, 100_000) });
      this.logger?.log("info", "prompt finished", { delivery_id: delivery.delivery_id, conversation_id: delivery.conversation_id, status: entry.cancelled ? "cancelled" : "completed" });
    } catch (error) {
      this.emit("PROMPT_DONE", { delivery_id: delivery.delivery_id, conversation_id: delivery.conversation_id, status: "error", error: String(error) });
      this.logger?.log("error", "prompt failed", { delivery_id: delivery.delivery_id, conversation_id: delivery.conversation_id, error: String(error) });
    }
  }
}

function safeName(value) { return String(value).replace(/[^a-zA-Z0-9._-]/g, "_"); }
function sanitise(value) {
  try { return JSON.parse(JSON.stringify(value, (key, item) => /api.?key|authorization|secret|token/i.test(key) ? "[redacted]" : item)); }
  catch { return "[unserializable Pi event]"; }
}
