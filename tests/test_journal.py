from __future__ import annotations

from pathlib import Path

from app.journal import PHASE_ACCEPTED, PHASE_DONE, PHASE_STARTED, Journal


def test_write_read_remove(tmp_path: Path):
    journal = Journal(tmp_path)
    journal.write("c1", PHASE_ACCEPTED)
    assert journal.read("c1")["phase"] == PHASE_ACCEPTED

    journal.write("c1", PHASE_DONE, result={"status": "COMPLETED"})
    assert journal.read("c1")["result"]["status"] == "COMPLETED"

    journal.remove("c1")
    assert journal.read("c1") is None


def test_unacked_results_are_what_resume_replays(tmp_path: Path):
    journal = Journal(tmp_path)
    journal.write("done", PHASE_DONE, result={"status": "COMPLETED", "exit_code": 0})
    journal.write("running", PHASE_STARTED)

    unacked = journal.unacked_results()
    assert [e["command_id"] for e in unacked] == ["done"]
    assert unacked[0]["result"]["exit_code"] == 0


def test_orphaned_started_entries_are_reported_lost(tmp_path: Path):
    """A command that was running when the process died has no process left to wait for."""
    journal = Journal(tmp_path)
    journal.write("a", PHASE_STARTED)
    journal.write("b", PHASE_ACCEPTED)
    journal.write("c", PHASE_DONE, result={"status": "COMPLETED"})

    assert sorted(e["command_id"] for e in journal.orphaned_started()) == ["a", "b"]


def test_corrupt_entry_is_discarded_rather_than_crashing_startup(tmp_path: Path):
    journal = Journal(tmp_path)
    journal.write("good", PHASE_DONE, result={"status": "COMPLETED"})
    (tmp_path / "broken.json").write_text("{not json", encoding="utf-8")

    entries = journal.all_entries()
    assert [e["command_id"] for e in entries] == ["good"]
    assert not (tmp_path / "broken.json").exists()  # cleaned up on the way past
