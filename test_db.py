"""SQLite regression tests; every test uses a temporary database."""
import csv
import io
import sqlite3

import pytest
import db


@pytest.fixture
def test_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "calls.db")
    db.init_db()
    return db


ANALYSIS = {
    "reply": "Hello.", "summary": "Caller asks about an appointment.", "intent": "Appointment",
    "urgency": "Low", "risk": "Low", "review_required": False,
    "suggested_action": "accept", "sensitive_info_requested": False,
}


def test_calls_analytics_exports_and_sensitive_redaction(test_db):
    store = test_db
    call_id = 1760000000000
    store.save_turn(call_id, "Can I book 10 AM?", ANALYSIS, "gemini", 850, "Mom")
    store.save_turn(call_id, "'; DROP TABLE calls; --", {**ANALYSIS, "risk": "High", "suggested_action": "decline"}, "gemini", 700)
    call = store.get_call(call_id)
    assert [turn["turn_no"] for turn in call["turns"]] == [1, 2]
    assert call["turns"][1]["caller_message"] == "'; DROP TABLE calls; --"
    assert store.complete_call(call_id, "Transferred")
    assert not store.complete_call(call_id, "Declined")
    assert store.get_call(call_id)["outcome"] == "Transferred"

    store.complete_call(call_id + 1, "Declined", "Unknown caller")
    summary = store.analytics_summary()
    assert summary["totals"] == {"calls": 2, "completed": 2, "abandoned": 0, "turns": 2, "calls_with_analysis": 1}
    assert summary["outcomes"] == {"AI handled": 0, "Transferred": 1, "Declined": 1}
    assert summary["call_risk"] == {"Low": 0, "Medium": 0, "High": 1}
    assert summary["avg_gemini_latency_ms"] == 775

    rows = store.calls_csv_rows()
    assert len(rows) == 2 and rows[0]["turn_count"] == 2
    csv_text = store.to_csv(store.turns_csv_rows(), store.TURN_COLUMNS)
    assert csv_text.startswith("\ufeff")
    parsed = list(csv.reader(io.StringIO(csv_text.lstrip("\ufeff"))))
    assert parsed[0] == store.TURN_COLUMNS
    assert store.csv_cell("=1+1") == "'=1+1"

    sensitive = "My password is do-not-store"
    store.save_turn(call_id + 2, sensitive, ANALYSIS, "rule_sensitive", 100)
    assert store.get_call(call_id + 2)["turns"][0]["caller_message"] == store.REDACTED_CALLER_MESSAGE


def test_invalid_call_data_rolls_back_and_owner_is_enforced(test_db):
    store = test_db
    with pytest.raises(ValueError):
        store.complete_call(5, "Maybe")
    with pytest.raises(ValueError):
        store.save_turn(6, "hi", ANALYSIS, "unknown_source")
    with pytest.raises(sqlite3.IntegrityError):
        store.save_turn(7, "hi", {**ANALYSIS, "urgency": "Extreme"}, "gemini")
    assert store.get_call(7) is None

    user_id = store.create_user("owner", "owner@example.test", "hash")
    store.complete_call(8, "Declined", user_id=user_id)
    with pytest.raises(PermissionError):
        store.complete_call(8, "Declined", user_id=user_id + 1)


def test_empty_analytics_has_no_fabricated_records(test_db):
    assert test_db.analytics_summary()["empty"] is True
    assert test_db.analytics_summary()["action_agreement"]["rate"] is None


def test_captcha_expires_and_does_not_return_the_answer(test_db):
    store = test_db
    challenge = store.create_captcha()
    assert set(challenge) == {"id", "question"}
    with store._conn() as conn:
        conn.execute("UPDATE captcha_challenges SET expires_at = ? WHERE id = ?", ("2000-01-01T00:00:00+00:00", challenge["id"]))
    assert not store.verify_captcha(challenge["id"], 1)
