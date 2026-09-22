import assert from "node:assert/strict";
import { test } from "node:test";
import { describeFailure } from "../src/prompt-failure.mjs";

test("a refused prompt is named by what refused it, not by its status line", () => {
  // The provider's own words, classified. "429 Too Many Requests: too many requests"
  // tells a person nothing about whether to wait, fix a key, or top up an account.
  assert.equal(describeFailure(new Error("429 Too Many Requests: too many requests")).reason, "rate_limit");
  assert.equal(describeFailure(new Error("RESOURCE_EXHAUSTED: quota for requests per minute")).reason, "rate_limit");
  assert.equal(describeFailure(Object.assign(new Error("slow down"), { status: 429 })).reason, "rate_limit");
  // A rate-limit body routinely mentions a quota; calling that billing sends somebody
  // to the wrong page, so 429 is tested before anything else.
  assert.equal(describeFailure(new Error("402 Payment Required: insufficient credit")).reason, "quota");
  assert.equal(describeFailure(new Error("529 overloaded_error: Overloaded")).reason, "overloaded");
  assert.equal(describeFailure(new Error("401 Unauthorized: authentication failed")).reason, "auth");
  assert.equal(describeFailure(new Error("unknown Pi model: github-copilot/gpt-9")).reason, "no_model");
  assert.equal(describeFailure(new Error("ENOENT: no such file or directory")).reason, "error");
});

test("what the provider asked for is passed on, and what it leaked is not", () => {
  const limited = describeFailure(new Error("Rate limit reached. retry-after: 30"));
  assert.equal(limited.reason, "rate_limit");
  assert.equal(limited.retry_after_seconds, 30);

  // Nonsense and absurd waits are dropped rather than shown to somebody as a promise.
  assert.equal(describeFailure(new Error("rate limit; retry after a while")).retry_after_seconds, undefined);
  assert.equal(describeFailure(new Error("429 rate limit, retry-after: 999999")).retry_after_seconds, undefined);

  // A failing request is exactly where a credential comes back in an error body, and
  // this one is about to be written into a chat anybody in the room can read.
  const leaked = describeFailure(new Error('401 invalid api key: "sk-live-abcdef123456"'));
  assert.equal(leaked.reason, "auth");
  assert.equal(leaked.error.includes("sk-live-abcdef123456"), false);
  assert.match(leaked.error, /\[redacted\]/);

  // Something that fails without saying anything still says something.
  assert.equal(describeFailure(new Error("")).error, "The agent failed without saying why.");
});
