"""FastAPI integration tests using temporary SQLite files and fake Gemini responses."""
import json
from pathlib import Path

import db

# main.py initializes its configured DB during import; keep that bootstrap away
# from the application's callguardian.db even before test fixtures are created.
db.DB_PATH = Path(__file__).parent / ".test-api-import.db"
import main
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "api.db")
    db.init_db()
    main._login_attempts.clear()
    with TestClient(main.app) as test_client:
        yield test_client


def solve(question):
    expression = question.removesuffix(" = ?")
    a, op, b = expression.split()
    return {"+": lambda: int(a) + int(b), "-": lambda: int(a) - int(b), "×": lambda: int(a) * int(b)}[op]()


def captcha_payload(client):
    challenge = client.get("/captcha").json()
    return {"captcha_id": challenge["id"], "captcha_ans": solve(challenge["question"])}


def register(client, username="alice", email="alice@example.test"):
    return client.post("/auth/register", json={
        "username": username, "email": email,
        "password": "TestPassword123!", "confirm": "TestPassword123!",
        **captcha_payload(client),
    })


def login(client, username="alice", password="TestPassword123!"):
    return client.post("/auth/login", json={
        "credential": username, "password": password, **captcha_payload(client),
    })


def test_registration_login_logout_and_protected_routes(client):
    assert client.get("/analytics/summary").status_code == 401
    assert register(client).status_code == 201
    bad_login = client.post("/auth/login", json={"credential": "alice", "password": "wrong", **captcha_payload(client)})
    assert bad_login.status_code == 401

    response = login(client)
    assert response.status_code == 200
    assert "cgai_session" in response.cookies
    assert client.get("/auth/me").json()["username"] == "alice"
    assert client.get("/analytics/summary").status_code == 200
    assert client.get("/calls?limit=201").status_code == 422

    csrf = client.cookies.get("cgai_csrf")
    assert csrf
    call_id = 1760000000000
    saved = client.post("/calls/complete", headers={"X-CSRF-Token": csrf}, json={
        "client_call_id": call_id, "outcome": "Declined", "caller_name": "Unknown caller",
    })
    assert saved.status_code == 200 and saved.json()["recorded"] is True
    assert client.get("/calls").json()["calls"][0]["id"] == call_id
    assert client.get("/analytics/summary").json()["totals"]["calls"] == 1
    calls_csv = client.get("/export/calls.csv")
    assert calls_csv.status_code == 200 and calls_csv.text.startswith("\ufeffcall_id,")
    calls_json = client.get("/export/calls.json")
    assert calls_json.status_code == 200 and calls_json.json()["calls"][0]["id"] == call_id

    assert client.post("/auth/logout").status_code == 403
    logout = client.post("/auth/logout", headers={"X-CSRF-Token": csrf})
    assert logout.status_code == 200
    assert client.get("/auth/me").status_code == 401
    assert register(client, "bob", "bob@example.test").status_code == 201
    assert login(client, "bob").status_code == 200
    assert client.get("/calls").json()["calls"] == []


def test_captcha_is_required_one_time_and_invalid_values_are_rejected(client):
    challenge = client.get("/captcha").json()
    body = {"credential": "alice", "password": "password", "captcha_id": challenge["id"], "captcha_ans": solve(challenge["question"]) + 1}
    assert client.post("/auth/login", json=body).status_code == 422
    body["captcha_ans"] = solve(challenge["question"])
    # Wrong answer consumes the one-use challenge.
    assert client.post("/auth/login", json=body).status_code == 422


def test_gemini_success_and_failure_response_paths(client, monkeypatch):
    assert register(client).status_code == 201
    assert login(client).status_code == 200

    captured = {}
    class FakeModels:
        def generate_content(self, **kwargs):
            captured.update(kwargs)
            class Result:
                text = '{"reply":"Hello","summary":"Routine call","intent":"Greeting","urgency":"Low","risk":"Low","review_required":false,"suggested_action":"accept","sensitive_info_requested":false}'
            return Result()

    class FakeClient:
        models = FakeModels()

    monkeypatch.setattr(main, "client", FakeClient())
    token = client.cookies.get("cgai_csrf")
    response = client.post("/chat", headers={"X-CSRF-Token": token}, json={
        "message": "Hello", "client_call_id": 1760000000001,
        "caller_name": "Test caller",
        "history": [{"role": "caller", "content": "Good morning"},
                    {"role": "assistant", "content": "How can I help?"}],
    })
    assert response.status_code == 200 and response.json()["reply"] == "Hello"
    assert [turn["role"] for turn in json.loads(captured["contents"])] == ["caller", "assistant", "caller"]
    assert json.loads(captured["contents"])[-1]["content"] == "Hello"
    empty = client.post("/chat", headers={"X-CSRF-Token": token}, json={"message": "  "})
    assert empty.status_code == 400

    class BrokenModels:
        def generate_content(self, **kwargs):
            raise TimeoutError("simulated timeout")

    monkeypatch.setattr(main, "client", type("FakeClient", (), {"models": BrokenModels()})())
    response = client.post("/chat", headers={"X-CSRF-Token": token}, json={"message": "Hello again"})
    assert response.status_code == 502

    class RejectedCredentialModels:
        def generate_content(self, **kwargs):
            raise main.genai.errors.ClientError(401, {"error": {"message": "credential rejected"}})

    monkeypatch.setattr(main, "client", type("FakeClient", (), {"models": RejectedCredentialModels()})())
    response = client.post("/chat", headers={"X-CSRF-Token": token}, json={"message": "Credential error"})
    assert response.status_code == 502
    assert "GEMINI_API_KEY" in response.json()["detail"]
    assert "credential rejected" not in response.json()["detail"]

    class MalformedModels:
        def generate_content(self, **kwargs):
            class Result:
                text = "not JSON"
            return Result()

    monkeypatch.setattr(main, "client", type("FakeClient", (), {"models": MalformedModels()})())
    response = client.post("/chat", headers={"X-CSRF-Token": token}, json={"message": "Malformed result"})
    assert response.status_code == 502


def test_missing_gemini_key_is_an_explicit_service_error(client, monkeypatch):
    assert register(client).status_code == 201
    assert login(client).status_code == 200
    monkeypatch.setattr(main, "client", None)
    token = client.cookies.get("cgai_csrf")
    response = client.post("/chat", headers={"X-CSRF-Token": token}, json={"message": "Hello"})
    assert response.status_code == 503
