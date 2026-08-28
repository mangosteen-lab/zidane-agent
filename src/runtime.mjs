import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { discoverSkills } from "./agent-data.mjs";
import { readSecretValue, resolveLlmProfile } from "./config.mjs";
import { contextTools } from "./context-tools.mjs";
import { prepareSandbox, sandboxTools } from "./sandbox.mjs";

const COMPACT_PROMPT = `Summarise this entire conversation as a durable note for your future self.
Capture the decisions reached, the constraints discovered, and anything you would need to
resume this work later. Leave out pleasantries and anything already obvious. Write prose,
no more than 300 words, and include no credentials or secret values.`;

/** Why a prompt was refused, so the control plane can decide whether to queue it. */
export class BusyError extends Error {
  constructor(reason) {
    super(reason === "conversation" ? "this conversation is already running" : "at capacity");
    this.reason = reason;
  }
}

export class PiRuntime {
  #active = new Map();
  // Conversations with a run in flight. A session is derived from the conversation id,
  // so two concurrent runs would open two Pi sessions over one workspace and one
  // session history — they would interleave and corrupt each other.
  #running = new Set();
  constructor(config, local, emit, logger, memory, journal) {
    this.config = config; this.local = local; this.emit = emit;
    this.logger = logger; this.memory = memory; this.journal = journal;
    // Set once the agent-data store exists. A session writes skills through that same
    // store, so what it saves cannot interleave with an edit made from the browser.
    this.data = null;
  }
  get active() { return this.#active.size; }
  /** In-flight runs, so a caller can wait for the runtime to settle. */
  get activeTasks() { return [...this.#active.values()].map((entry) => entry.task).filter(Boolean); }

  prompt(delivery) {
    if (this.#active.has(delivery.delivery_id)) return;
    const conversation = String(delivery.conversation_id ?? delivery.delivery_id);
    if (this.#running.has(conversation)) throw new BusyError("conversation");
    if (this.active >= this.config.capacity) throw new BusyError("capacity");
    const entry = { session: null, cancelled: false, task: null, conversation };
    this.#running.add(conversation);
    const task = this.#run(delivery, entry)
      .catch((error) => this.emit("PROMPT_DONE", {
        delivery_id: delivery.delivery_id, conversation_id: delivery.conversation_id,
        status: "error", error: String(error),
      }))
      .finally(() => {
        this.#active.delete(delivery.delivery_id);
        this.#running.delete(conversation);
      });
    entry.task = task;
    this.#active.set(delivery.delivery_id, entry);
    return task;
  }

  /**
   * Summarise a thread into durable memory, then drop its session and workspace.
   *
   * The summary is written by the agent itself, so it is the model that decides what
   * was worth keeping. A failure leaves everything in place: the control plane retries
   * on the next sweep rather than losing the thread.
   */
  /**
   * Run one prompt and return only its text.
   *
   * Occupies a slot like any other run, so a summary cannot outrun the capacity the
   * agent advertises.
   */
  async summarise(conversationId, prompt) {
    const conversation = safeName(conversationId);
    if (this.#running.has(conversation)) throw new BusyError("conversation");
    if (this.active >= this.config.capacity) throw new BusyError("capacity");
    this.#running.add(conversation);
    try {
      const workspace = resolve(this.local.workspaces, conversation);
      const { session } = await this.#session(conversation, workspace, {});
      let text = "";
      session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
          text += event.assistantMessageEvent.delta;
        }
      });
      await session.prompt(prompt);
      return text.trim().slice(0, 10_000);
    } finally {
      this.#running.delete(conversation);
    }
  }

  async compact(conversationId) {
    const conversation = safeName(conversationId);
    if (this.#running.has(conversation)) throw new BusyError("conversation");
    this.#running.add(conversation);
    try {
      const workspace = resolve(this.local.workspaces, conversation);
      const { session } = await this.#session(conversation, workspace, {});
      let summary = "";
      session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
          summary += event.assistantMessageEvent.delta;
        }
      });
      await session.prompt(COMPACT_PROMPT);
      const text = summary.trim().slice(0, 10_000);
      if (!text) throw new Error("the model returned no summary");
      const entry = await this.memory.add(
        { text, tags: ["thread", conversation], sensitivity: "normal" },
        "agent",
      );
      await this.#discard(conversation);
      return { memory_id: entry.id, summary: text };
    } finally {
      this.#running.delete(conversation);
    }
  }

  /** Forget a thread outright: session history and working files both. */
  async discard(conversationId) {
    const conversation = safeName(conversationId);
    if (this.#running.has(conversation)) throw new BusyError("conversation");
    await this.#discard(conversation);
  }

  async #discard(conversation) {
    await rm(resolve(this.local.workspaces, conversation), { recursive: true, force: true });
    await rm(resolve(this.local.sessions, `${conversation}.json`), { force: true });
  }

  /**
   * Run one scheduled task to completion and return its report.
   *
   * Deliberately outside `config.capacity`: a nightly task must not be refused because
   * someone is chatting, and it is `CronScheduler` that bounds how many may run at once.
   * Nothing is emitted — no `PROMPT_EVENT`, no `PROMPT_DONE` — so the run stays invisible
   * to every chat surface; the log and the task's history are the only trace. The session
   * and its workspace are destroyed when the run ends, whether it succeeded or not.
   */
  async runTask({ id, prompt, skills = [], onProgress }) {
    const conversation = safeName(`cron-${id}`);
    if (this.#running.has(conversation)) throw new BusyError("conversation");
    this.#running.add(conversation);
    const workspace = resolve(this.local.workspaces, conversation);
    // A task that names skills sees only those: an unattended run should not be able to
    // reach for a skill the schedule never authorised.
    const staged = skills.length ? resolve(this.local.workspaces, `${conversation}.skills`) : null;
    try {
      if (staged) await stageSkills(this.local.skills, skills, staged);
      let profile = {};
      try { profile = await resolveLlmProfile(this.local); } catch { profile = {}; }
      const { session } = await this.#session(conversation, workspace, profile, staged ? [staged] : [this.local.skills]);
      let text = "";
      session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
          text += event.assistantMessageEvent.delta;
          // Reported, never emitted: a caller can watch the run without it reaching a chat.
          onProgress?.({ text });
        } else if (event.type.includes("tool")) {
          const tool = toolLabel(event);
          if (tool) onProgress?.({ tool });
        }
      });
      await session.prompt(prompt);
      return text.trim().slice(0, 20_000);
    } finally {
      this.#running.delete(conversation);
      if (staged) await rm(staged, { recursive: true, force: true });
      await this.#discard(conversation);
    }
  }

  cancel(deliveryId) {
    const entry = this.#active.get(deliveryId);
    if (!entry) return false;
    entry.cancelled = true;
    void entry.session?.abort();
    return true;
  }

  /** Everything a prompt needs before it can be sent: workspace, model, session. */
  async #session(conversation, workspace, profile, skillPaths = [this.local.skills]) {
    await mkdir(workspace, { recursive: true });
    // $HOME and $TMPDIR point inside the workspace, so scratch files die with the
    // conversation instead of piling up in the container or reaching the agent's own
    // state. A skill that says to write to ~/ still lands here.
    const sandbox = await prepareSandbox(workspace);
    const runtime = await ModelRuntime.create({ authPath: resolve(this.local.auth, "pi-auth.json"), modelsPath: resolve(this.local.config, "models.json") });
    if (profile.provider && profile.secret_value) {
      await runtime.setRuntimeApiKey(profile.provider, readSecretValue(profile.secret_value));
    }
    const soul = await readFile(this.local.soul, "utf8");
    const loader = new DefaultResourceLoader({
      cwd: workspace,
      agentDir: this.local.root,
      systemPromptOverride: () => soul,
      additionalSkillPaths: skillPaths,
    });
    await loader.reload();
    const model = profile.provider && profile.model ? runtime.getModel(profile.provider, profile.model) : undefined;
    if (profile.provider && profile.model && !model) throw new Error(`unknown Pi model: ${profile.provider}/${profile.model}`);
    return createAgentSession({
      cwd: workspace,
      sessionManager: SessionManager.continueRecent(workspace, this.local.sessions),
      agentDir: this.local.root,
      model,
      thinkingLevel: profile.thinking_level ?? "medium",
      modelRuntime: runtime,
      resourceLoader: loader,
      tools: profile.tools?.length ? profile.tools : ["read", "grep", "find", "ls", "write", "edit", "bash", "remember", "retrieve_memory", "forget_memory", "search_knowledge", "draft_skill"],
      // The sandboxed bash/write/edit shadow Pi's built-ins of the same name.
      customTools: [...sandboxTools(workspace, sandbox), ...contextTools(this.local, this.memory, this.data)],
    });
  }

  async #run(delivery, entry) {
    this.logger?.log("info", "prompt started", { delivery_id: delivery.delivery_id, conversation_id: delivery.conversation_id });
    const conversation = safeName(delivery.conversation_id ?? delivery.delivery_id);
    const workspace = resolve(this.local.workspaces, conversation);
    // The control plane only names a profile; the agent owns every profile's contents.
    let profile = {};
    try { profile = await resolveLlmProfile(this.local, delivery.profile_id); }
    catch { profile = {}; }
    const { session } = await this.#session(conversation, workspace, profile);
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
      await this.journal?.record({
        conversation: delivery.conversation_id ?? conversation,
        prompt: delivery.text,
        answer: responseText,
        status: entry.cancelled ? "cancelled" : "completed",
      });
      this.emit("PROMPT_DONE", { delivery_id: delivery.delivery_id, conversation_id: delivery.conversation_id, status: entry.cancelled ? "cancelled" : "completed", final_text: responseText.slice(0, 100_000) });
      this.logger?.log("info", "prompt finished", { delivery_id: delivery.delivery_id, conversation_id: delivery.conversation_id, status: entry.cancelled ? "cancelled" : "completed" });
    } catch (error) {
      this.emit("PROMPT_DONE", { delivery_id: delivery.delivery_id, conversation_id: delivery.conversation_id, status: "error", error: String(error) });
      this.logger?.log("error", "prompt failed", { delivery_id: delivery.delivery_id, conversation_id: delivery.conversation_id, error: String(error) });
    }
  }
}

/** Copy the named skills into a directory of their own for one scheduled run. */
export async function stageSkills(root, names, destination) {
  const wanted = new Set(names.map((name) => String(name).trim().toLowerCase()));
  const available = await discoverSkills(root);
  await mkdir(destination, { recursive: true });
  const copied = [];
  for (const skill of available) {
    if (!wanted.has(skill.name.trim().toLowerCase()) && !wanted.has(skill.skill_id)) continue;
    await cp(skill.directory, resolve(destination, safeName(skill.name)), { recursive: true });
    copied.push(skill.name);
  }
  if (!copied.length) throw new Error(`none of the task's skills are installed on this agent: ${names.join(", ")}`);
  return copied;
}

/** A tool event's name, whichever shape Pi reports it in. */
function toolLabel(event) {
  const name = event.toolName ?? event.tool?.name ?? event.toolCall?.name ?? event.name;
  return typeof name === "string" && name.length <= 60 ? name : null;
}

function safeName(value) { return String(value).replace(/[^a-zA-Z0-9._-]/g, "_"); }
function sanitise(value) {
  try { return JSON.parse(JSON.stringify(value, (key, item) => /api.?key|authorization|secret|token/i.test(key) ? "[redacted]" : item)); }
  catch { return "[unserializable Pi event]"; }
}
