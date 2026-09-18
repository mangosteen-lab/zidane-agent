/**
 * Asking the account for what this agent should have.
 *
 * A person who adds a skill or rotates a credential expects agents to pick it up. Until
 * now that only happened when somebody remembered to press Sync, so a revoked
 * credential could sit live on an agent for weeks and a corrected skill never arrive.
 *
 * The fix is a timer, and the timer is **here** rather than on the control plane. That
 * is not a detail: the control plane deliberately runs no scheduler, and adding one to
 * push resources at agents would be the first of them. Instead the agent asks — the
 * same direction as `TASK_REPORT` and `CONNECTOR_STATUS` — and the server answers by
 * sending the `account.refresh` it would have sent anyway. Nothing on the server knows
 * what time it is.
 *
 * Asking is cheap and idempotent: the reconciler compares by `source_id` and writes
 * only what differs, so an unchanged account costs one round trip.
 */

export const MIN_MINUTES = 5;
export const DEFAULT_MINUTES = 360;

/** Read the interval from the environment, clamped to something sane. */
export function syncMinutes(environment = process.env) {
  const raw = Number.parseInt(environment.ZIDANE_AGENT_ACCOUNT_SYNC_MINUTES ?? "", 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MINUTES;
  return Math.max(MIN_MINUTES, Math.min(raw, 7 * 24 * 60));
}

export function syncEnabled(environment = process.env) {
  return (environment.ZIDANE_AGENT_ACCOUNT_SYNC ?? "true") !== "false";
}

export class AccountSyncScheduler {
  #timer = null;
  #last = 0;

  constructor(emit, logger, { minutes = syncMinutes(), now = Date.now } = {}) {
    this.emit = emit;
    this.logger = logger;
    this.intervalMs = minutes * 60_000;
    this.now = now;
  }

  start() {
    if (this.#timer) return;
    // Checked more often than it fires: the tick is cheap and a long interval should
    // not mean a long wait after a restart lands mid-period.
    this.#timer = setInterval(() => this.tick(), Math.min(this.intervalMs, 60_000));
    this.#timer.unref?.();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * Ask now, whatever the clock says.
   *
   * Called on `REGISTERED`, because a reconnect is exactly when an agent is most likely
   * to be out of date — it may have been down while something changed, and nothing
   * queued that for it.
   */
  request(reason = "reconnect") {
    this.#last = this.now();
    this.logger?.log("info", "asking the account for its resources", { reason });
    this.emit("ACCOUNT_SYNC_REQUEST", { reason });
  }

  tick(now = this.now()) {
    if (now - this.#last < this.intervalMs) return false;
    this.request("timer");
    return true;
  }
}
