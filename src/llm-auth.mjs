import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";

/**
 * Runs Pi's provider-owned login flows on the agent. Zidane only relays safe
 * interaction events; the credential store and refresh tokens stay local.
 */
export class PiAuthManager {
  #flows = new Map();

  constructor(local, send, logger, runtimeFactory = null) {
    this.local = local;
    this.send = send;
    this.logger = logger;
    this.runtimeFactory = runtimeFactory ?? (() => ModelRuntime.create({
      authPath: resolve(local.secrets, "pi-auth.json"),
      modelsPath: resolve(local.config, "models.json"),
      refreshOnCreate: false,
    }));
  }

  start(message) {
    const flowId = String(message.flow_id ?? "");
    // Pi runtimes share one credential store. Keep authentication serialized so
    // two provider logins cannot race while updating pi-auth.json.
    if (!flowId || this.#flows.size > 0) return false;
    const flow = { controller: new AbortController(), prompts: new Map(), task: null };
    flow.task = this.#run(flowId, message, flow).finally(() => this.#flows.delete(flowId));
    this.#flows.set(flowId, flow);
    return true;
  }

  input(message) {
    const flow = this.#flows.get(String(message.flow_id ?? ""));
    const prompt = flow?.prompts.get(String(message.prompt_id ?? ""));
    if (!prompt) return false;
    flow.prompts.delete(String(message.prompt_id));
    prompt.resolve(String(message.value ?? ""));
    return true;
  }

  cancel(flowId) {
    const flow = this.#flows.get(String(flowId));
    if (!flow) return false;
    flow.controller.abort();
    return true;
  }

  async #run(flowId, message, flow) {
    const providerId = String(message.provider ?? "");
    const authMethod = String(message.auth_method ?? "");
    let credential = typeof message.credential === "string" ? message.credential : "";
    try {
      const runtime = await this.runtimeFactory();
      const provider = runtime.getProvider(providerId);
      if (!provider) throw new Error(`unknown Pi provider: ${providerId}`);
      if (authMethod !== "api_key" && authMethod !== "oauth") {
        throw new Error(`unsupported authentication method: ${authMethod}`);
      }
      if (!provider.auth?.[authMethod === "api_key" ? "apiKey" : "oauth"]) {
        throw new Error(`${providerId} does not support ${authMethod}`);
      }

      await runtime.login(providerId, authMethod, {
        signal: flow.controller.signal,
        notify: (event) => {
          this.send("LLM_AUTH_EVENT", { flow_id: flowId, event: safeEvent(event) });
        },
        prompt: (prompt) => {
          if (authMethod === "api_key" && credential && ["secret", "text"].includes(prompt.type)) {
            const value = credential;
            credential = "";
            return Promise.resolve(value);
          }
          if (prompt.type === "secret") {
            return Promise.reject(new Error("credential input must come from a Zidane secret"));
          }
          return this.#prompt(flowId, prompt, flow);
        },
      });
      const configured = await runtime.checkAuth(providerId, { signal: flow.controller.signal });
      if (!configured) throw new Error(`${providerId} login completed without usable credentials`);
      this.send("LLM_AUTH_DONE", {
        flow_id: flowId,
        provider: providerId,
        auth_method: configured.type,
        source: configured.source ?? "Pi credential store",
        configured: true,
      });
      this.logger?.log("info", "LLM provider authentication completed", {
        provider: providerId,
        auth_method: configured.type,
      });
    } catch (error) {
      const cancelled = flow.controller.signal.aborted;
      this.send("LLM_AUTH_DONE", {
        flow_id: flowId,
        provider: providerId,
        auth_method: authMethod,
        configured: false,
        cancelled,
        error: cancelled ? "Login cancelled" : String(error),
      });
      this.logger?.log(cancelled ? "info" : "error", "LLM provider authentication failed", {
        provider: providerId,
        auth_method: authMethod,
        cancelled,
        error: cancelled ? "Login cancelled" : String(error),
      });
    } finally {
      credential = "";
      for (const pending of flow.prompts.values()) pending.reject(new Error("Login ended"));
      flow.prompts.clear();
    }
  }

  #prompt(flowId, prompt, flow) {
    const promptId = crypto.randomUUID();
    this.send("LLM_AUTH_PROMPT", {
      flow_id: flowId,
      prompt_id: promptId,
      prompt: safePrompt(prompt),
    });
    return new Promise((resolvePrompt, rejectPrompt) => {
      const abort = () => {
        flow.prompts.delete(promptId);
        rejectPrompt(new Error("Login cancelled"));
      };
      flow.controller.signal.addEventListener("abort", abort, { once: true });
      prompt.signal?.addEventListener("abort", abort, { once: true });
      flow.prompts.set(promptId, {
        resolve: (value) => {
          flow.controller.signal.removeEventListener("abort", abort);
          prompt.signal?.removeEventListener("abort", abort);
          resolvePrompt(value);
        },
        reject: rejectPrompt,
      });
    });
  }
}

function safeEvent(event) {
  if (event.type === "auth_url") return { type: event.type, url: String(event.url).slice(0, 4_000), instructions: String(event.instructions ?? "").slice(0, 2_000) };
  if (event.type === "device_code") return {
    type: event.type,
    user_code: String(event.userCode).slice(0, 200),
    verification_uri: String(event.verificationUri).slice(0, 4_000),
    interval_seconds: Number(event.intervalSeconds ?? 0),
    expires_in_seconds: Number(event.expiresInSeconds ?? 0),
  };
  if (event.type === "info") return { type: event.type, message: String(event.message).slice(0, 2_000), links: (event.links ?? []).slice(0, 10).map((link) => ({ url: String(link.url).slice(0, 4_000), label: String(link.label ?? "").slice(0, 200) })) };
  return { type: "progress", message: String(event.message ?? "Working…").slice(0, 2_000) };
}

function safePrompt(prompt) {
  const result = {
    type: prompt.type,
    message: String(prompt.message ?? "Continue authentication").slice(0, 2_000),
    placeholder: String(prompt.placeholder ?? "").slice(0, 500),
  };
  if (prompt.type === "select") {
    result.options = prompt.options.slice(0, 50).map((option) => ({
      id: String(option.id).slice(0, 200),
      label: String(option.label).slice(0, 500),
      description: String(option.description ?? "").slice(0, 1_000),
    }));
  }
  return result;
}
