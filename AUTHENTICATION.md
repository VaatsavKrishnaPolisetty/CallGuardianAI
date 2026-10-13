# Local login and registration

The authentication flow uses Argon2id password hashes, one-use server-verified
CAPTCHA challenges, and database-backed sessions in HttpOnly cookies. Keep the
existing `.env` file private; authentication does not read or change the Gemini
API key.

## Install and start

From the project directory in PowerShell:

```powershell
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt -r requirements-test.txt
```

Start the API in one terminal:

```powershell
python -m uvicorn main:app --reload
```

Start the static frontend server in a second terminal:

```powershell
python -m http.server 5500 --bind 127.0.0.1
```

Open `http://127.0.0.1:5500/login.html`. Create an account from the registration
link, solve the displayed arithmetic CAPTCHA, and sign in with the username or
email address and password. The dashboard redirects unauthenticated visitors to
login; logging out invalidates the server-side session.

Calls recorded before accounts existed remain in SQLite but have no trustworthy
owner, so they are not shown or exported to any account. New call history,
analytics, and exports are scoped to the authenticated user.

For deployment over HTTPS, set `AUTH_COOKIE_SECURE=true` before starting the
API. The default is intentionally suitable only for local HTTP development.

Registration password rules are configurable in the private `.env` file:
`AUTH_PASSWORD_MIN_LENGTH` (8–128, default `8`) and
`AUTH_PASSWORD_REQUIRE_UPPERCASE`, `AUTH_PASSWORD_REQUIRE_DIGIT`, and
`AUTH_PASSWORD_REQUIRE_SPECIAL` (each defaults to `true`). The registration
page retrieves these public requirements from the API so its guidance matches
server-side enforcement. Email validation checks format only; it does not verify
that an address exists or can receive mail.

## Test

Run the authentication, API, database, analytics, and export regression tests:

```powershell
python -m pytest -q
```

The pytest suite uses temporary SQLite databases; the existing `callguardian.db`
is not used for test data. Browser-specific interactions are not automated yet.
