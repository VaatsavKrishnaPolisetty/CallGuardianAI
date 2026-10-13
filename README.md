# 🛡️ CallGuardianAI

> **Autonomous AI Voice Call Guardian** with real-time scam screening, speech-to-text microphone input, ultra-realistic NVIDIA NIM neural TTS, personal knowledge vault RAG, and an interactive kinetic UI.

---

## 🌟 What is CallGuardianAI?

CallGuardianAI acts as your personal autonomous call screening agent. It answers unknown calls, screens for scams or robocall scripts using **Gemini 2.5 Flash**, recalls your private preferences using a **Personal Knowledge Vault (RAG & CRM)**, and speaks naturally with ultra-low latency human-like voice synthesis powered by **NVIDIA NIM**.

---

## ✨ Key Features

- 🛡️ **Real-Time Scam Defense**: Analyzes caller intent turn-by-turn with Gemini to identify spoofing and phishing attempts.
- 🎙️ **Microphone Voice Input**: Speak directly into your microphone as the caller with real-time transcription.
- 🔊 **NVIDIA NIM Neural TTS**: Empathic, ultra-realistic human voices with sub-250ms synthesis latency.
- 🧠 **Personal Knowledge Vault**: Private rules and FAQs (e.g., *"Never accept sales pitches"*, *"Delivery drop-off is behind the blue gate"*) referenced seamlessly in conversation.
- 👥 **Caller Memory CRM**: Automatically recognizes repeat callers and remembers context across calls.
- 🌊 **Modern Kinetic UI**: Butter-smooth momentum scrolling powered by **Lenis** and interactive animations (shape morphing, line drawing, motion paths, draggable threat dial) powered by **Anime.js**.

---

## 🚀 Quick Start in 3 Simple Steps

### 1. Clone the Repository & Install Dependencies

```bash
git clone https://github.com/VaatsavKrishnaPolisetty/CallGuardianAI.git
cd CallGuardianAI

# Create and activate a Python virtual environment
python3 -m venv .venv
source .venv/bin/activate   # On Windows: .venv\Scripts\activate

# Install requirements
pip install -r requirements.txt -r requirements-test.txt
```

---

### 2. Configure Environment Variables

Copy the example environment template:

```bash
cp .env.example .env
```

Open `.env` in any editor and add your API keys:

```env
# Google Gemini API Key (Required for conversation reasoning)
# Get a key at https://aistudio.google.com/
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-2.5-flash-lite

# NVIDIA NIM API Key (Optional: For neural voice playback)
# Get a key at https://build.nvidia.com/
NVIDIA_API_KEY=your_nvidia_api_key_here
```

---

### 3. Run the App

Start the backend and frontend in two terminal windows:

#### Terminal 1 — Start the FastAPI Backend:
```bash
python3 -m uvicorn main:app --host 127.0.0.1 --port 8001 --reload
```

#### Terminal 2 — Start the Frontend Server:
```bash
python3 -m http.server 5500
```

Open your browser and visit: **[http://localhost:5500](http://localhost:5500)** (or **[http://localhost:5500/login.html](http://localhost:5500/login.html)**).

---

## 🧪 Running the Tests

To verify everything is working properly:

```bash
# Run backend Python tests (Auth, Database, FastAPI, Gemini)
python3 -m pytest

# Run frontend chat workflow tests
node --test test_chat_workflow.cjs
```

---

## 🔒 Security & Privacy

- Sensitive files such as `.env` and local database files (`*.db`) are strictly excluded from version control.
- Calls and audio cache are kept local and private.
- Authentication uses secure HTTP-only cookies and CSRF protection.

---

## 📄 License

MIT License. See [LICENSE](LICENSE) for details.
