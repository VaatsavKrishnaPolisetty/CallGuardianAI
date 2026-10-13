# CallGuardianAI

CallGuardianAI is a React dashboard for **simulated** call screening. It uses a
Vite frontend, a FastAPI backend, SQLite for accounts and call history, Gemini
for call analysis, and the browser's Web Speech API for optional playback. It
does not connect to a telephone network or place or receive real calls.

## Architecture

- `frontend/`: React 19, TypeScript, Vite, and React Router SPA.
- `main.py`: FastAPI API and backend-only Gemini integration (`google-genai`).
- `db.py`: SQLite accounts, sessions, call records, and analysis storage.
- `/health`: process health check; it does not depend on Gemini credentials.
- `/config-status`: reports only whether a Gemini key is configured.

Production uses two Render services: a Static Site for the SPA and a single
instance Web Service for the API. The API uses a persistent disk because the
application stores users, sessions, CAPTCHA challenges, and call history in
SQLite. The disk means the API must remain a single instance. Existing local
`callguardian.db` data is not automatically copied to Render.

## Local setup (PowerShell)

Use Python 3.10+ and Node.js 22.14+.

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt -r requirements-test.txt
Copy-Item .env.example .env
```

Set `GEMINI_API_KEY` in the project `.env` for real Gemini requests. Keep the
key in the backend environment only; never use a `VITE_` variable for it. The
backend loads `.env` relative to `main.py`, without overriding hosting
environment variables. The default model is `gemini-3.8-flash`; change
`GEMINI_MODEL` only to a model enabled for the key's project.

Run the API and frontend in separate terminals:

```powershell
python -m uvicorn main:app --host 127.0.0.1 --port 8001
```

```powershell
cd frontend
npm install
npm run dev
```

Open the Vite URL printed by the frontend (normally `http://127.0.0.1:5500`).
Local Vite development defaults to `http://127.0.0.1:8001`. Set
`VITE_API_URL` in `frontend/.env.local` only if the local API uses another URL.

## Render deployment with the Blueprint

1. Commit and push this repository to GitHub.
2. In Render, choose **New + → Blueprint**, connect the GitHub repository, and
   select the branch containing `render.yaml`.
3. Review the two services: `callguardianai-api` (Python Web Service) and
   `callguardianai` (Static Site). The Blueprint configures the API health
   check, a 1 GB persistent disk at `/var/data`, HTTPS cookies, and the frontend
   API URL. The API uses one worker and should stay at one instance.
4. Set `GEMINI_API_KEY` in the API service's Environment settings to a valid
   Gemini Developer API key. The Blueprint prompts for it on initial creation;
   for an existing service, enter it manually and save/deploy. Never put it in
   GitHub, `render.yaml`, or a `VITE_` variable.
5. The configured service names yield
   `https://callguardianai.onrender.com` and
   `https://callguardianai-api.onrender.com`. If you choose different service
   names or use a custom domain, update `VITE_API_URL` on the Static Site and
   `CORS_ALLOWED_ORIGINS` on the API to match, then redeploy both services.
6. Inspect build and runtime logs. Open the Static Site, register an account,
   sign in, and send two consecutive assistant messages. `/health` should return
   `{"status":"ok"}`. The chat uses live Gemini only when a real key is set.

The Blueprint uses Render's paid Starter API service and persistent disk to
preserve SQLite data. Confirm current Render pricing before creating resources.
Render disks are single-instance and are not available to build commands. For
larger or multi-instance production deployments, migrate SQLite to a managed
PostgreSQL database and move login rate limiting to shared storage.

## Environment variables

| Service | Variable | Value |
| --- | --- | --- |
| API | `GEMINI_API_KEY` | Required for AI chat; set as a Render secret |
| API | `GEMINI_MODEL` | `gemini-3.8-flash` by default |
| API | `CALLGUARDIAN_DB_PATH` | `/var/data/callguardian.db` on Render |
| API | `AUTH_COOKIE_SECURE` | `true` on HTTPS |
| API | `CORS_ALLOWED_ORIGINS` | Exact deployed frontend origin(s), no wildcard |
| Frontend | `VITE_API_URL` | Public API URL; contains no secret |

`/health` reports process health even when `GEMINI_API_KEY` is missing. A chat
request then returns a clear configuration error. Invalid credentials, quota
errors, unsupported models, timeouts, and network failures are classified
without logging credentials or caller prompt text.

## Checks

```powershell
python -m pytest -q
python -m compileall -q main.py db.py gemini_config.py
cd frontend
npm install
npm run build
```

The optional live Gemini smoke test below sends a real request and may consume
quota:

```powershell
python test_gemini.py
```
