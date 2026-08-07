from __future__ import annotations

from app.redaction import Redactor


def test_scrub_replaces_every_occurrence():
    redactor = Redactor(["s3cr3t-token"])
    assert redactor.scrub("auth=s3cr3t-token and s3cr3t-token") == "auth=*** and ***"


def test_short_values_are_never_redacted():
    """Redacting a 1-2 char value would destroy the log for no security benefit."""
    redactor = Redactor(["ab", "x"])
    assert redactor.scrub("ab x abc") == "ab x abc"


def test_longest_secret_wins_when_they_overlap():
    redactor = Redactor(["abcd", "abcdefgh"])
    assert redactor.scrub("value=abcdefgh") == "value=***"


def test_secret_split_across_chunks_is_still_caught():
    """The case that makes naive per-chunk redaction leak: a value straddling a read."""
    redactor = Redactor(["supersecret"])
    first = redactor.feed("token=super")
    second = redactor.feed("secret rest of line\n")
    tail = redactor.flush()
    combined = first + second + tail
    assert "supersecret" not in combined
    assert "***" in combined
    assert combined.endswith("rest of line\n")


def test_streaming_preserves_all_non_secret_content():
    redactor = Redactor(["hunter2xx"])
    chunks = ["line one\n", "pass=hunter", "2xx\n", "line three\n"]
    out = "".join(redactor.feed(c) for c in chunks) + redactor.flush()
    assert out == "line one\npass=***\nline three\n"


def test_inactive_redactor_is_a_passthrough():
    redactor = Redactor([])
    assert not redactor.active
    assert redactor.feed("anything") == "anything"
    assert redactor.flush() == ""
