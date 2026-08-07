"""Secret redaction, applied on the agent before any output leaves the host.

This is the layer that actually catches leaks. Keeping secrets out of execution state
(which the backend does) does nothing about `set -x`, `env`, or a stack trace that happens
to include a token — by then the value is in the process's stdout, and the only place to
scrub it is here.

Chunk boundaries are handled by holding back a tail of `max_secret_len - 1` bytes so a
secret split across two reads is still caught.
"""
from __future__ import annotations

MASK = "***"
MIN_SECRET_LEN = 4


class Redactor:
    def __init__(self, secrets: list[str] | None = None):
        # Longest first, so an overlapping pair does not leave a fragment behind.
        self._secrets = sorted(
            {s for s in (secrets or []) if s and len(s) >= MIN_SECRET_LEN},
            key=len, reverse=True)
        self._max_len = max((len(s) for s in self._secrets), default=0)
        self._carry = ""

    @property
    def active(self) -> bool:
        return bool(self._secrets)

    def scrub(self, text: str) -> str:
        """Redact a complete string (no boundary handling)."""
        if not self._secrets or not text:
            return text
        for secret in self._secrets:
            text = text.replace(secret, MASK)
        return text

    def feed(self, chunk: str) -> str:
        """Redact a streamed chunk, holding back enough tail to catch a split secret.

        Order matters: **scrub first, then split.** Splitting first and scrubbing the
        emitted half leaks a secret that straddles the boundary — its prefix goes out
        unmasked and its suffix is emitted next round with nothing left to match against.

        Scrubbing first means the only unmasked secret material that can remain is a
        *prefix* awaiting more input, and a prefix is at most `max_len - 1` characters,
        so holding back exactly that many guarantees it stays in the carry.
        """
        if not self._secrets:
            return chunk
        buffer = self.scrub(self._carry + chunk)
        hold = self._max_len - 1
        if hold <= 0:
            self._carry = ""
            return buffer
        if len(buffer) <= hold:
            self._carry = buffer
            return ""
        emit, self._carry = buffer[:-hold], buffer[-hold:]
        return emit

    def flush(self) -> str:
        """Emit whatever was held back. Call once at end of stream."""
        remaining, self._carry = self._carry, ""
        return self.scrub(remaining)
