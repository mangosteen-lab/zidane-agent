/**
 * What went wrong with a prompt, in terms the person who asked can act on.
 *
 * A failed prompt used to reach nobody. `PROMPT_DONE` carried `status: "error"` and the
 * error string, and the control plane records a message only when there is a reply — so
 * a provider refusing to serve the request looked exactly like an agent going quiet, in
 * a chat window with no way to tell the two apart. The most useful thing to say is
 * usually the provider's own words, so they travel; what they need first is a name for
 * what happened, because "429 Too Many Requests: too many requests" tells a person
 * nothing about whether to wait, fix a key, or give up.
 *
 * Redaction comes from `connectors.mjs` for the same reason it exists there: a failing
 * request is exactly where a credential comes back in an error body.
 */

import { redact } from "./connectors.mjs";

/**
 * The limit the caller hit, in the order a message has to be tested.
 *
 * `429` first: a rate-limit body routinely mentions a quota and a plan, and calling
 * that a billing problem sends somebody to the wrong page. Each pattern is matched
 * against the provider's text, which is why they are broad — one provider's `429` is
 * another's `RESOURCE_EXHAUSTED`.
 */
const KINDS = [
  ["rate_limit", /\b429\b|rate[\s_-]?limits?|too many requests|slow[\s_-]?down|resource[\s_-]?exhausted/i],
  ["quota", /\b402\b|quota (?:exceeded|reached)|out of credit|insufficient (?:quota|credit|funds|balance)|billing|payment required|spend(?:ing)? limit/i],
  ["overloaded", /\b(?:503|529)\b|overloaded|server is busy|temporarily unavailable|capacity/i],
  ["auth", /\b401\b|\b403\b|unauthorized|unauthenticated|invalid[\s_-]?api[\s_-]?key|authentication failed|no credentials|not (?:signed|logged) in/i],
  ["no_model", /unknown pi model|model not found|no model (?:configured|selected)|unknown provider/i],
];

/** `retry-after: 30`, or a provider saying it in prose. Seconds, and only if sane. */
function retryAfterSeconds(text) {
  const found = /retry[\s_-]?after["'\s:=]*(\d{1,6})|try again in (\d{1,6})\s*(?:seconds|secs|s)\b/i.exec(text);
  const seconds = Number(found?.[1] ?? found?.[2]);
  return Number.isInteger(seconds) && seconds > 0 && seconds <= 86_400 ? seconds : 0;
}

/**
 * Classify one failed prompt.
 *
 * `cancelled` is deliberately not an error: somebody stopped it on purpose, and saying
 * so in red in the transcript would be a lie about what happened.
 */
export function describeFailure(error) {
  // An error thrown with no message still has a name worth keeping — `AbortError` says
  // something, the bare `Error` every empty throw carries does not.
  const raw = error instanceof Error ? (error.message.trim() || error.name || "") : String(error ?? "");
  const cleaned = redact(raw).trim();
  const message = cleaned && cleaned !== "Error" ? cleaned : "The agent failed without saying why.";
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  const haystack = Number.isInteger(status) ? `${status} ${message}` : message;
  const reason = KINDS.find(([, pattern]) => pattern.test(haystack))?.[0] ?? "error";
  const retryAfter = retryAfterSeconds(haystack);
  // Named for the frame it goes into: `PROMPT_DONE` has always carried `error`, and a
  // second name for the same string would be one more thing to keep in step.
  return { reason, error: message, ...(retryAfter ? { retry_after_seconds: retryAfter } : {}) };
}
