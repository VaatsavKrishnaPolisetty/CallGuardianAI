"""Safe, isolated authentication/database smoke tests."""
from argon2 import PasswordHasher

import db


def test_auth_basic(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "auth.db")
    db.init_db()

    challenge = db.create_captcha()
    question = challenge["question"].removesuffix(" = ?")
    a, operator, b = question.split()
    answer = {"+": lambda: int(a) + int(b), "-": lambda: int(a) - int(b), "×": lambda: int(a) * int(b)}[operator]()
    assert db.verify_captcha(challenge["id"], answer)
    assert not db.verify_captcha(challenge["id"], answer)

    password_hash = PasswordHasher().hash("TestPassword123!")
    user_id = db.create_user("testuser", "test@example.com", password_hash)
    user = db.get_user_by_username("testuser")
    assert user and user["id"] == user_id

    token = db.create_session(user_id, "127.0.0.1", "pytest")
    session = db.get_session(token)
    assert session and session["user_id"] == user_id
    db.delete_session(token)
    assert db.get_session(token) is None
