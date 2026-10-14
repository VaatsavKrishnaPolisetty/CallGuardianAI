'use strict';
/* CallGuardianAI — simulated calls with backend-powered assistant replies. */

/* ═════════════════════════════════════════════════════════════════════
   Auth module — session cookie + CSRF header for every fetch to the API
   ═════════════════════════════════════════════════════════════════════ */
const defaultApiHost = window.location.hostname || '127.0.0.1';
const API = window.CGAI_API_BASE || `http://${defaultApiHost}:8001`;
const CSRF_COOKIE  = 'cgai_csrf';
const CSRF_HEADER  = 'X-CSRF-Token';
const SESSION_COOKIE = 'cgai_session';

const Auth = {
  user: null,      // { id, username, email } once loaded

  /** Read the CSRF token from the readable JS cookie (set by /auth/login). */
  csrfToken() {
    const match = document.cookie.split(';')
      .map(c => c.trim())
      .find(c => c.startsWith(CSRF_COOKIE + '='));
    return match ? decodeURIComponent(match.split('=').slice(1).join('=')) : '';
  },

  /** Wrapper around fetch that always includes credentials + CSRF header. */
  async fetch(url, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };
    const csrf = this.csrfToken();
    if (csrf) headers[CSRF_HEADER] = csrf;

    const res = await fetch(url, {
      ...options,
      credentials: 'include',
      headers,
    });

    // Any 401 means the session expired or was invalidated — send to login
    if (res.status === 401) {
      window.location.replace('login.html');
      return res; // unreachable but keeps callers happy
    }
    return res;
  },

  /** Fetch current user info and populate the sidebar. */
  async init() {
    if (window.CGAI_AUTH_USER) {
      Auth.user = window.CGAI_AUTH_USER;
    } else {
      try {
        const res = await Auth.fetch(`${API}/auth/me`);
        if (!res.ok) { window.location.replace('login.html'); return; }
        Auth.user = await res.json();
      } catch {
        toast('Backend not reachable. Some features may not work.', true);
        return;
      }
    }
    // Populate sidebar user panel
    const name = Auth.user.username;
    const avatarEl = document.getElementById('userAvatar');
    const nameEl   = document.getElementById('userName');
    if (avatarEl) avatarEl.textContent = name.slice(0, 2);
    if (nameEl)   nameEl.textContent   = name;
  },

  /** POST /auth/logout, clear local state, redirect to login. */
  async logout() {
    try {
      await Auth.fetch(`${API}/auth/logout`, { method: 'POST' });
    } catch { /* ignore network errors — redirect anyway */ }
    window.location.replace('login.html');
  },
};
 
/* ---------- Helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nowTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const digits = n => n.replace(/\D/g, '');
const USER_STORAGE_KEY = `cgai:${window.CGAI_AUTH_USER?.id || 'default'}`;
let reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    
/* ---------- State (persisted in localStorage when available) ---------- */
const DEFAULTS = () => ({
  agentOn: false,
  schedule: { on: false, start: '22:00', end: '07:00' },
  rules: { spam: true, screen: true, urgent: true, favorites: true },
  contacts: [
    { id: 1, name: 'Mom', number: '+91 98480 11223', type: 'known', pref: 'ring' },
    { id: 2, name: 'Dr. Rao Clinic', number: '+91 98850 44556', type: 'known', pref: 'screen' },
    { id: 3, name: 'Telemarketer Block', number: '+91 80001 99887', type: 'unknown', pref: 'block' }
  ],
  calls: [],
  stats: { calls: 0, spam: 0, saved: 0, transfers: 0 },
  outcomes: { ai: 0, transfer: 0, decline: 0 },
  week: [0, 0, 0, 0, 0, 0, 0],
  voice: 'Calm',
  nvidiaVoice: 'alloy',
  autoMicSend: true,
  voicePlayback: true,
  reduce: false
});
let state = DEFAULTS();
try {
  const s = JSON.parse(localStorage.getItem(USER_STORAGE_KEY) || 'null');
  if (s) {
    state = { ...state, ...s };
    if (Array.isArray(state.calls)) {
      state.calls = state.calls.filter(c => c && c.id !== 101 && c.id !== 102);
    }
  }
} catch (e) { /* storage unavailable */ }
const save = () => { try { localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ } };
let active = null;       // the one active simulated call
let timers = [];         // pending timeouts for the active call
let selectedCall = null;
let scheduleTurnedOn = false;
let realAnalytics = null;
const PENDING_COMPLETIONS_KEY = `cgaiPendingCompletions:${window.CGAI_AUTH_USER?.id || 'default'}`;
const pendingCompletions = new Map();
const completionRetryTimers = new Map();
const completionRequests = new Set();
try {
  const saved = JSON.parse(localStorage.getItem(PENDING_COMPLETIONS_KEY) || '[]');
  if (Array.isArray(saved)) {
    saved.forEach(item => {
      if (item && Number.isSafeInteger(item.client_call_id) && item.client_call_id > 0
        && item.client_call_id <= 9999999999999
        && ['AI handled', 'Transferred', 'Declined'].includes(item.outcome)
        && (item.caller_name === null
          || (typeof item.caller_name === 'string' && item.caller_name.length <= 80))) {
        pendingCompletions.set(item.client_call_id, {
          client_call_id: item.client_call_id,
          outcome: item.outcome,
          caller_name: item.caller_name,
          attempts: Number.isInteger(item.attempts) && item.attempts >= 0 ? item.attempts : 0
        });
      }
    });
  }
} catch (error) {
  console.error('Could not load pending call outcomes.');
}
function persistPendingCompletions() {
  try {
    localStorage.setItem(PENDING_COMPLETIONS_KEY, JSON.stringify([...pendingCompletions.values()]));
    return true;
  } catch (error) {
    console.error('Could not persist pending call outcomes.');
    return false;
  }
}
 
/* ---------- Simulation data ---------- */
const SCENARIOS = [
  { name: 'Mom', number: '+91 98480 11223', reason: 'Wants to know if you are free for dinner tonight.', intent: 'Personal check-in', urgency: 'Low', risk: 'Low',
    lines: [['ai', 'Hello, you have reached the user\'s assistant. How can I help?'], ['caller', 'It is Mom, are we still on for dinner?'], ['ai', 'I will pass that on right away.']] },
  { name: 'Dr. Rao Clinic', number: '+91 98850 44556', reason: 'Reminder about tomorrow\'s 10:30 appointment.', intent: 'Appointment reminder', urgency: 'Medium', risk: 'Low',
    lines: [['ai', 'Hello, how can I help you?'], ['caller', 'Confirming the 10:30 appointment tomorrow.'], ['ai', 'Confirmed. I will note it on the calendar.']] },
  { name: 'Unknown caller', number: '+91 70123 55661', reason: 'Says you won a free vacation and needs card details.', intent: 'Possible scam', urgency: 'Low', risk: 'High',
    lines: [['ai', 'Who is calling, and why?'], ['caller', 'You won a trip, please read your card number.'], ['ai', 'We do not share payment details by phone. Goodbye.']] },
  { name: 'Unknown caller', number: '+91 63000 22119', reason: 'Courier says a package needs a signature today.', intent: 'Delivery', urgency: 'Medium', risk: 'Medium',
    lines: [['ai', 'May I have the tracking reference?'], ['caller', 'It is 7741, delivery at 5 PM.'], ['ai', 'Thanks, I will let the user know.']] },
  { name: 'Unknown caller', number: '+91 99000 31415', reason: 'Says a family member was in an accident.', intent: 'Emergency claim', urgency: 'High', risk: 'Medium',
    lines: [['ai', 'Can you tell me who is involved?'], ['caller', 'Your cousin, please call the hospital now.'], ['ai', 'Understood. Flagging this as urgent.']] },
  { name: 'Telemarketer Block', number: '+91 80001 99887', reason: 'Loan offer with pre-approved limit.', intent: 'Sales call', urgency: 'Low', risk: 'High',
    lines: [['ai', 'Hello, what is this regarding?'], ['caller', 'Pre-approved loan for you.'], ['ai', 'Not interested. Goodbye.']] }
];
const RULES = [
  ['spam', 'Block high-risk callers', 'Declines callers flagged as likely scams.'],
  ['screen', 'Screen unknown callers', 'AI asks who is calling and why.'],
  ['urgent', 'Escalate urgent calls', 'Transfers high-urgency calls to you.'],
  ['favorites', 'Always ring favorites', 'Contacts set to "ring" skip the AI.']
];
 
/* ---------- Toasts ---------- */
function toast(msg, warn) {
  const t = document.createElement('div');
  t.className = 'toast' + (warn ? ' warn' : '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 3200);
}
 
/* ---------- Text-to-speech (NVIDIA NIM Speech API + Browser Web Speech fallback) ---------- */
const TTS = {
  ok: true,
  voice: null, muted: false, speaking: false, token: 0, ready: null, ui: {}, audioEl: null,
  pick() {
    if (!('speechSynthesis' in window)) return;
    const en = speechSynthesis.getVoices().filter(v => /^en([-_]|$)/i.test(v.lang));
    const score = v => (/en[-_]IN/i.test(v.lang) ? 100 : 0) + (/natural|neural|online/i.test(v.name) ? 30 : 0)
      + (/google|microsoft|samantha|heera|neerja|ravi/i.test(v.name) ? 10 : 0) + (/en[-_](US|GB)/i.test(v.lang) ? 5 : 0);
    this.voice = en.sort((a, b) => score(b) - score(a))[0] || null;
    if (this.ui.note) {
      this.ui.note.textContent = (this.voice ? `Voice: ${this.voice.name} (${this.voice.lang}). ` : 'Using the browser default voice. ') + 'CallGuardian Speech Engine.';
    }
  },
  whenReady() {
    if (!('speechSynthesis' in window)) return Promise.resolve();
    if (this.ready) return this.ready;
    this.ready = new Promise(res => {
      let settled = false, fallback;
      const done = () => {
        if (settled) return;
        settled = true; clearTimeout(fallback); this.pick(); res();
      };
      if (speechSynthesis.getVoices().length) return done();
      speechSynthesis.addEventListener('voiceschanged', done, { once: true });
      fallback = setTimeout(done, 1500);
    });
    return this.ready;
  },
  setSpeaking(on) { this.speaking = on; if (this.ui.stop) this.ui.stop.disabled = !on; },
  audioCache: new Map(),
  playAudioUrl(audioUrl) {
    return new Promise((resolve, reject) => {
      if (this.audioEl) {
        try { this.audioEl.pause(); } catch (e) {}
        this.audioEl = null;
      }
      const audio = new Audio(audioUrl);
      this.audioEl = audio;
      this.setSpeaking(true);
      audio.onended = () => {
        this.audioEl = null;
        this.setSpeaking(false);
        resolve();
      };
      audio.onerror = (err) => {
        this.audioEl = null;
        this.setSpeaking(false);
        reject(err);
      };
      audio.play().catch(reject);
    });
  },
  async speakNvidia(text, voiceOverride = null) {
    const voice = voiceOverride || state.nvidiaVoice || 'alloy';
    const cacheKey = `${voice}:${text}`;
    if (this.audioCache.has(cacheKey)) {
      return this.playAudioUrl(this.audioCache.get(cacheKey));
    }

    const res = await Auth.fetch(`${API}/tts`, {
      method: 'POST',
      body: JSON.stringify({
        text,
        voice: voice
      })
    });
    if (!res.ok) throw new Error('NVIDIA TTS returned ' + res.status);
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await res.json();
      if (!data.supported || data.fallback_to_browser) {
        throw new Error(data.reason || 'NVIDIA TTS not available');
      }
    }
    const blob = await res.blob();
    if (!blob || blob.size < 64) throw new Error('Empty audio');
    const audioUrl = URL.createObjectURL(blob);
    this.audioCache.set(cacheKey, audioUrl);
    return this.playAudioUrl(audioUrl);
  },
  async speak(text, manual, voiceOverride = null) {
    if (!text || !text.trim()) return Promise.resolve();
    if (this.muted) { if (manual) toast('Voice is muted. Unmute to hear replies.', true); return Promise.resolve(); }
    if (state.voicePlayback === false && !manual) return Promise.resolve();

    this.stop();

    // 1. Always use NVIDIA AI Voice first
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.speakNvidia(text, voiceOverride);
        return;
      } catch (e) {
        lastErr = e;
        const errStr = String(e);
        if (errStr.includes('429')) {
          // Rate-limited: wait 800ms and try once more before failing
          await new Promise(r => setTimeout(r, 800));
        } else {
          break;
        }
      }
    }

    // If NVIDIA is configured or status is online, DO NOT play the old browser robot voice!
    if (window.CGAI_NVIDIA_ONLINE || state.nvidiaVoice) {
      console.warn('NVIDIA TTS was unable to synthesize this line:', lastErr);
      if (manual) toast('NVIDIA Voice engine is busy; please try again in a moment.', true);
      return Promise.resolve();
    }

    // 2. Web Speech API fallback (only if NVIDIA is completely unconfigured)
    if (!('speechSynthesis' in window)) {
      if (manual) toast('Speech synthesis not supported in this browser.', true);
      return Promise.resolve();
    }
    const id = ++this.token;
    return new Promise(resolve => {
      let done = false, safety;
      const end = () => { if (done) return; done = true; clearTimeout(safety); if (id === this.token) this.setSpeaking(false); resolve(); };
      try { speechSynthesis.cancel(); } catch (e) { /* ignore */ }
      this.whenReady().then(() => {
        if (id !== this.token) return end();
        const u = new SpeechSynthesisUtterance(text);
        if (this.voice) { u.voice = this.voice; u.lang = this.voice.lang; } else u.lang = 'en-IN';
        u.rate = { Calm: .95, Friendly: 1.03, Formal: .92 }[state.voice] || 1;
        u.onend = end;
        u.onerror = ev => { end(); };
        safety = setTimeout(end, Math.max(3000, text.length * 110 + 2000));
        this.setSpeaking(true);
        try { speechSynthesis.resume(); speechSynthesis.speak(u); } catch (e) { end(); }
      }).catch(() => { end(); });
    });
  },
  stop() {
    this.token++;
    if (this.audioEl) {
      try { this.audioEl.pause(); } catch (e) {}
      this.audioEl = null;
    }
    if ('speechSynthesis' in window) {
      try { speechSynthesis.cancel(); } catch (e) {}
    }
    this.setSpeaking(false);
  },
  renderMute() { this.ui.mute.textContent = this.muted ? 'Unmute voice' : 'Mute voice'; this.ui.mute.setAttribute('aria-pressed', String(this.muted)); },
  init() {
    this.muted = !!state.muted;
    const bar = document.createElement('div');
    bar.innerHTML = '<div class="actions"><button class="btn" id="ttsMute" type="button"></button><button class="btn" id="ttsStop" type="button" disabled>Stop speaking</button></div><p class="muted" id="ttsNote" style="margin-top:10px"></p>';
    $('#callCard').appendChild(bar);
    this.ui = { mute: $('#ttsMute'), stop: $('#ttsStop'), note: $('#ttsNote') };
    this.renderMute();
    this.ui.mute.addEventListener('click', () => { this.muted = !this.muted; state.muted = this.muted; save(); if (this.muted) this.stop(); this.renderMute(); toast(this.muted ? 'Voice muted' : 'Voice on'); });
    this.ui.stop.addEventListener('click', () => this.stop());
    if ('speechSynthesis' in window) {
      speechSynthesis.addEventListener('voiceschanged', () => this.pick());
    }
    this.pick();
  }
};

/* ---------- Microphone Voice Input (Speech-to-Text) ---------- */
const MicInput = {
  recognizer: null,
  isListening: false,
  supported: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
  init() {
    const btn = $('#micBtn');
    if (!btn) return;
    if (!this.supported) {
      btn.title = 'Speech recognition requires Chrome, Edge or Safari';
    }
    btn.addEventListener('click', () => this.toggle());
  },
  toggle() {
    if (this.isListening) {
      this.stop();
    } else {
      this.start();
    }
  },
  start() {
    if (!this.supported) {
      toast('Microphone speech recognition is not supported in this browser. Try Chrome or Edge.', true);
      return;
    }
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    try {
      this.recognizer = new SpeechRec();
      this.recognizer.continuous = false;
      this.recognizer.interimResults = true;
      this.recognizer.lang = 'en-US';

      const btn = $('#micBtn');
      const input = $('#chatInput');

      this.recognizer.onstart = () => {
        this.isListening = true;
        if (btn) {
          btn.classList.add('mic-active');
          btn.textContent = '🔴 Listening…';
        }
        toast('🎙️ Speak naturally as the caller…');
      };

      this.recognizer.onresult = (e) => {
        let transcript = '';
        for (let i = 0; i < e.results.length; i++) {
          transcript += e.results[i][0].transcript;
        }
        if (input) {
          input.value = transcript;
        }
      };

      this.recognizer.onerror = (e) => {
        this.stop();
        if (e.error !== 'no-speech') {
          toast(`Microphone error: ${e.error}`, true);
        }
      };

      this.recognizer.onend = () => {
        this.stop();
        if (input && input.value.trim() && state.autoMicSend !== false) {
          submitChatMessage();
        }
      };

      this.recognizer.start();
    } catch (err) {
      this.stop();
      toast('Could not start microphone: ' + err.message, true);
    }
  },
  stop() {
    this.isListening = false;
    const btn = $('#micBtn');
    if (btn) {
      btn.classList.remove('mic-active');
      btn.textContent = '🎙️ Speak as Caller';
    }
    if (this.recognizer) {
      try { this.recognizer.stop(); } catch (e) {}
      this.recognizer = null;
    }
  }
};

/* ---------- Synchronized Audio Transcript Player ---------- */
const AudioPlayer = {
  isPlaying: false,
  currentTurnIdx: 0,
  turns: [],
  token: 0,
  init() {
    const playBtn = $('#audioPlayBtn');
    const scrubber = $('#audioScrubber');
    if (playBtn) playBtn.addEventListener('click', () => this.togglePlay());
    if (scrubber) {
      scrubber.addEventListener('input', (e) => {
        const val = +e.target.value;
        const total = this.turns.length || 1;
        const targetIdx = Math.min(this.turns.length - 1, Math.floor((val / 100) * total));
        this.seekToTurn(targetIdx);
      });
    }
  },
  loadCall(call) {
    this.stop();
    this.turns = (call && Array.isArray(call.transcript)) ? call.transcript : [];
    this.currentTurnIdx = 0;
    const bar = $('#audioPlayerBar');
    if (!bar) return;
    if (this.turns.length > 0) {
      bar.hidden = false;
      const totalSec = Math.max(4, this.turns.length * 4);
      const min = Math.floor(totalSec / 60);
      const sec = totalSec % 60;
      $('#audioTotalTime').textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
      $('#audioCurTime').textContent = '00:00';
      $('#audioScrubber').value = 0;
    } else {
      bar.hidden = true;
    }
  },
  togglePlay() {
    if (this.isPlaying) this.pause();
    else this.play();
  },
  pause() {
    this.isPlaying = false;
    this.token++;
    TTS.stop();
    const btn = $('#audioPlayBtn');
    if (btn) btn.textContent = '▶ Play Call';
    this.clearTurnHighlights();
  },
  stop() {
    this.pause();
    this.currentTurnIdx = 0;
    const scrubber = $('#audioScrubber');
    if (scrubber) scrubber.value = 0;
    const curTime = $('#audioCurTime');
    if (curTime) curTime.textContent = '00:00';
  },
  clearTurnHighlights() {
    $$('#transcript .msg').forEach(el => el.classList.remove('turn-active-spoken'));
  },
  highlightTurn(idx) {
    this.clearTurnHighlights();
    const rows = $$('#transcript .msg');
    if (rows[idx]) {
      rows[idx].classList.add('turn-active-spoken');
      rows[idx].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    const scrubber = $('#audioScrubber');
    if (scrubber && this.turns.length > 1) {
      scrubber.value = Math.round((idx / (this.turns.length - 1)) * 100);
    }
    const curTime = $('#audioCurTime');
    if (curTime) {
      const curSec = idx * 4;
      const min = Math.floor(curSec / 60);
      const sec = curSec % 60;
      curTime.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    }
  },
  async seekToTurn(idx) {
    if (idx < 0 || idx >= this.turns.length) return;
    this.pause();
    TTS.stop();
    this.currentTurnIdx = idx;
    this.highlightTurn(idx);
    const [speaker, text] = this.turns[idx];
    const persona = speaker === 'caller' ? 'onyx' : (state.nvidiaVoice || 'alloy');
    await TTS.speak(text, true, persona);
  },
  async play() {
    if (!this.turns.length) return;
    this.isPlaying = true;
    const btn = $('#audioPlayBtn');
    if (btn) btn.textContent = '⏸ Pause Call';
    const currentToken = ++this.token;

    for (let i = this.currentTurnIdx; i < this.turns.length; i++) {
      if (!this.isPlaying || this.token !== currentToken) break;
      this.currentTurnIdx = i;
      this.highlightTurn(i);
      const [speaker, text] = this.turns[i];
      const persona = speaker === 'caller' ? 'onyx' : (state.nvidiaVoice || 'alloy');
      await TTS.speak(text, false, persona);
      if (!this.isPlaying || this.token !== currentToken) break;
      await new Promise(r => setTimeout(r, 600));
    }

    if (this.token === currentToken) {
      this.stop();
    }
  }
};

/* ---------- Navigation ---------- */
const TITLES = {
  heroLanding: ['Home', 'Autonomous Voice Intelligence, Real-Time Scam Defense & Knowledge Vault'],
  overview: ['Live Simulator', 'Simulated live view of your call agent'],
  calls: ['Calls', 'History and transcripts'],
  contacts: ['Contacts', 'Known and unknown callers'],
  rules: ['Automation Rules', 'Schedules and behavior'],
  analytics: ['Analytics', 'Real SQLite data from your call agent'],
  vault: ['Personal Knowledge Vault', 'Rules, FAQs & Caller Memory CRM'],
  settings: ['Settings', 'NVIDIA Models & Audio Engine']
};
function go(id) {
  $$('.view').forEach(v => v.classList.toggle('on', v.id === id));
  $$('#nav button').forEach(b => b.classList.toggle('on', b.dataset.go === id));
  $('#title').textContent = (TITLES[id] && TITLES[id][0]) || id;
  $('#sub').textContent = (TITLES[id] && TITLES[id][1]) || '';

  // Always reset scroll to top of the newly active view
  if (typeof lenisInstance !== 'undefined' && lenisInstance) {
    try {
      lenisInstance.scrollTo(0, { immediate: true });
    } catch (_) {}
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;

  if (id === 'heroLanding') {
    animateMetricCounters();
  }
  if (id === 'analytics') loadAnalytics();
  if (id === 'overview') { resizeOrb(); kick(); }
  if (id === 'calls') loadCalls();
  if (id === 'vault') { loadVault(); loadCRM(); }
  if (id === 'settings') checkNvidiaStatus();
}
window.go = go;

/* ---------- Agent mode ---------- */
function setAgent(on, fromSchedule) {
  state.agentOn = on;
  if (!fromSchedule) scheduleTurnedOn = false;
  $('#agentToggle').checked = on;
  $('#agentLabel').textContent = on ? 'Agent Mode on' : 'Agent Mode off';
  document.body.dataset.agent = on ? 'on' : 'off';
  refreshOrbText(); save(); kick();
  if (active && !active.handled) { active.decision = decide(active); renderDecision(); }
}
function refreshOrbText() {
  const phase = document.body.dataset.phase;
  $('#orbText').textContent = phase === 'ringing' ? 'Incoming call' : phase === 'handling' ? 'AI is handling the call' : state.agentOn ? 'Agent is listening' : 'Agent is off';
}
function setPhase(p) { document.body.dataset.phase = p; refreshOrbText(); kick(); }
 
/* ---------- Call workflow ---------- */
function findContact(num) { return state.contacts.find(c => digits(c.number) === digits(num)); }
 
function decide(call) {
  const c = findContact(call.number), r = state.rules;
  const pref = c ? c.pref : (r.screen ? 'screen' : 'ring');
  let action, why;
  if (!state.agentOn) { action = 'transfer'; why = 'Agent Mode is off, so the call rings you directly.'; }
  else if ((c && c.pref === 'block') || (!c && call.risk === 'High' && r.spam) || (call.risk === 'High' && r.spam && pref !== 'ring')) {
    action = 'decline'; why = `Risk is high (${call.intent.toLowerCase()}) and your block rule is on, so the call is declined.`;
  } else if ((call.urgency === 'High' && r.urgent) || (pref === 'ring' && r.favorites)) {
    action = 'transfer'; why = call.urgency === 'High' ? 'Urgent calls are escalated to you by your rule.' : `${call.name} is set to always ring you.`;
  } else { action = 'ai'; why = `${c ? 'Preference is "let AI screen"' : 'Unknown caller with screening on'}; low-risk, so the AI can collect details.`; }
  return { action, why };
}
const ACTION_LABEL = { ai: 'Handle with AI', transfer: 'Transfer to you', decline: 'Decline' };
const RECOMMENDATION_LABEL = { accept: 'Accept (simulated)', decline: 'Decline (simulated)', transfer: 'Transfer (simulated)' };
 
function simulate() {
  if (active) return toast('A simulated call is already in progress.', true);
  const base = SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)];
  const c = findContact(base.number);
  active = { ...base, name: c ? c.name : base.name, type: c ? c.type : 'unknown', id: Date.now(), handled: false,
    summary: '', reviewRequired: null, suggestedAction: null, sensitiveInfoRequested: false };
  active.decision = decide(active);
  setPhase('ringing'); renderCall(); renderDecision();
  toast('Simulated incoming call');
}
function act(kind, event) {
  if (!active) return toast('No active call. Simulate one first.', true);
  if (!event?.isTrusted) return;
  if (kind === 'ai') {
    if (active.handled) return;
    timers.forEach(clearTimeout); timers = [];
    active.handled = true;
    return runAI();
  }
  if (kind !== 'transfer' && kind !== 'decline') return;
  timers.forEach(clearTimeout); timers = [];
  active.handled = true;
  TTS.stop();
  finish(kind === 'transfer' ? 'Transferred' : 'Declined', kind === 'transfer' ? [['ai', 'Transferring you to the user now (simulated).']] : [['ai', 'Call declined by the user (simulated).']], event);
}
function runAI() {
  setPhase('handling');
  const tr = $('#liveTr'); tr.hidden = false; tr.innerHTML = '';
  $$('.actions .btn', $('#callBody')).forEach(b => { if (b.dataset.act === 'ai') b.disabled = true; });
  active.handled = true; active.chat = []; active.live = false; active.busy = false;
  const lines = active.lines, callId = active.id; let i = 0;
  const next = () => {   // show each line; AI lines are spoken aloud and the next line waits for the voice to finish
    if (!active || active.id !== callId) return;
    if (i >= lines.length) { goLive(); return; }   // scripted opening is done: the call stays open for typed messages
    const l = lines[i++]; addMsg(tr, l); active.chat.push(l);
    if (l[0] === 'ai') TTS.speak(l[1]).then(() => timers.push(setTimeout(next, 700)));
    else timers.push(setTimeout(next, 1400));
  };
  timers.push(setTimeout(next, 600));
}
/* ---------- Backend-backed conversation in simulated calls ---------- */
function setBusy(b) {
  active.busy = b; $('#chatInput').disabled = b; $('#chatSend').disabled = b;
  $('#chatComposer').setAttribute('aria-busy', String(b));
  $('#chatInput').placeholder = b ? 'Waiting for the assistant…' : 'Type what the caller says…';
  $('#chatSend').textContent = b ? 'Waiting…' : 'Send';
}
function goLive() {
  active.live = true; $('#chatBox').hidden = false; setBusy(false); $('#chatInput').focus();
  toast('Call is live. Type the caller\'s next message.');
}
async function sendCaller(raw, retryRow = null) {
  const text = CGAIChatWorkflow.normalizeMessage(raw);
  if (!active || !active.live) return toast('Wait for the assistant to finish its greeting.', true);
  if (active.busy) return toast('The assistant is still replying.', true);
  if (!text) return toast('Type a caller message first.', true);
  if (text.length > 200) return toast('Keep messages under 200 characters.', true);
  const callId = active.id, tr = $('#liveTr');
  if (!retryRow) {
    retryRow = [...tr.querySelectorAll('.msg.caller[data-status="failed"]')]
      .find((row) => row.dataset.text === text) || null;
  }
  const callerMsg = retryRow || addMsg(tr, ['caller', text]);
  callerMsg.dataset.status = 'pending';
  callerMsg.querySelector('[data-retry]')?.remove();
  callerMsg.querySelector('.msg-error')?.remove();
  active.chat.push(['caller', text]);
  const controller = new AbortController();
  active.requestController = controller;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 45000);
  $('#chatInput').value = '';
  const loadingMsg = addMsg(tr, ['ai', 'Reviewing caller message…']);
  loadingMsg.classList.add('pending');
  setBusy(true);
  await CGAIChatWorkflow.send({
    text,
    request: () => {
      const history = CGAIChatWorkflow.trimHistory(active.chat.slice(active.lines.length, -1).map(([who, content]) => ({
        role: who === 'ai' ? 'assistant' : 'caller', content
      })));
      return Auth.fetch(`${API}/chat`, {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({ message: text, client_call_id: callId, caller_name: active.name, history })
      });
    },
    onSuccess: async (data) => {
      if (!active || active.id !== callId) return;
      const reply = data.reply.trim();
      active.summary = data.summary.trim();
      active.intent = data.intent.trim();
      active.urgency = data.urgency;
      active.risk = data.risk;
      active.reviewRequired = data.review_required;
      active.suggestedAction = data.suggested_action;
      active.sensitiveInfoRequested = data.sensitive_info_requested;
      active.sentiment = data.sentiment || (active.risk === 'High' ? 'Aggressive' : active.urgency === 'High' ? 'Frustrated' : 'Neutral');
      active.stress_level = data.stress_level ?? (active.risk === 'High' ? 85 : active.urgency === 'High' ? 65 : 25);
      if (!active.trajectory) active.trajectory = [];
      active.trajectory.push({
        turn: active.trajectory.length + 1,
        sentiment: active.sentiment,
        stress: active.stress_level
      });
      const safetyWarning = active.sensitiveInfoRequested
        ? ' SECURITY WARNING: Never disclose OTPs, passwords, banking PINs, verification codes, CVVs, or full card details.'
        : '';
      active.decision = {
        action: data.suggested_action === 'accept' ? 'ai' : data.suggested_action,
        recommendation: data.suggested_action,
        why: `${active.summary}${safetyWarning} Review required: ${active.reviewRequired ? 'Yes' : 'No'}. Recommendation only; no cellular call action has been performed.`
      };
      renderDecision();
      callerMsg.dataset.status = 'sent';
      const metaSpan = document.createElement('span');
      metaSpan.className = `tag tag-sentiment ${active.sentiment.toLowerCase()}`;
      metaSpan.style.cssText = 'font-size:0.68rem;padding:1px 6px;margin-left:6px';
      metaSpan.textContent = `${active.sentiment} ${active.stress_level}%`;
      callerMsg.querySelector('small')?.appendChild(metaSpan);

      addMsg(tr, ['ai', reply, { sentiment: 'Neutral' }]);
      active.chat.push(['ai', reply]);
      await TTS.speak(reply);
    },
    onFailure: (error) => {
      if (!active || active.id !== callId) return;
      const message = timedOut
        ? 'The assistant is taking longer than expected. Please try again.'
        : error instanceof TypeError
          ? 'I could not connect to the assistant. Check that the backend is running, then try again.'
          : error.message;
      if (active.chat[active.chat.length - 1]?.[0] === 'caller'
        && active.chat[active.chat.length - 1]?.[1] === text) active.chat.pop();
      callerMsg.dataset.status = 'failed';
      const failureNote = document.createElement('small');
      failureNote.className = 'msg-error';
      failureNote.textContent = message;
      callerMsg.appendChild(failureNote);
      const retry = document.createElement('button');
      retry.type = 'button'; retry.className = 'btn'; retry.dataset.retry = 'true';
      retry.textContent = 'Retry'; retry.setAttribute('aria-label', `Retry message: ${text}`);
      callerMsg.appendChild(retry);
      $('#chatInput').value = text;
      toast(`${message} Your message is still here; use Retry to send it again.`, true);
    },
    onSettled: () => {
      clearTimeout(timeout);
      loadingMsg.remove();
      if (active && active.id === callId) {
        active.requestController = null;
        setBusy(false);
        $('#chatInput').focus();
      }
    }
  });
}
function endChat(event) { if (event?.isTrusted && active && active.live) { active.requestController?.abort(); TTS.stop(); finish('AI handled', active.chat, event); } }
function submitChatMessage() { sendCaller($('#chatInput').value); }
function bindChat() {
  $('#chatSend').addEventListener('click', submitChatMessage);
  $('#chatInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      submitChatMessage();
    }
  });
  $('#chatBox').addEventListener('click', e => { const c = e.target.closest('[data-chip]'); if (c) sendCaller(c.dataset.chip); });
  $('#liveTr').addEventListener('click', e => {
    const retry = e.target.closest('[data-retry]');
    const row = retry?.closest('.msg.caller');
    if (row && row.dataset.status === 'failed') sendCaller(row.dataset.text, row);
  });
  $('#chatEnd').addEventListener('click', endChat);
}

function addMsg(box, [who, text, meta], turnIdx = null) {
  const d = document.createElement('div');
  d.className = 'msg ' + who;
  d.dataset.text = text;
  if (turnIdx !== null) d.dataset.turnIdx = String(turnIdx);
  const speakerLabel = who === 'ai' ? 'Assistant' : 'Caller';
  let metaHtml = '';
  if (meta && meta.sentiment) {
    metaHtml = ` <span class="tag tag-sentiment ${meta.sentiment.toLowerCase()}" style="font-size:0.68rem;padding:1px 6px;margin-left:6px">${esc(meta.sentiment)}${meta.stress_level != null ? ' ' + meta.stress_level + '%' : ''}</span>`;
  }
  d.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center"><small>${speakerLabel}${metaHtml}</small></div><div class="msg-content">${esc(text)}</div>`;
  const replayBtn = document.createElement('button');
  replayBtn.className = 'btn';
  replayBtn.type = 'button';
  replayBtn.dataset.speak = 'true';
  if (turnIdx !== null) replayBtn.dataset.turnIdx = String(turnIdx);
  replayBtn.style.cssText = 'margin-top:6px;padding:3px 8px;font-size:0.75rem';
  replayBtn.textContent = '▶ Play';
  d.appendChild(replayBtn);
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
  return d;
}
function scheduleCompletionRetry(callId, delay) {
  if (completionRetryTimers.has(callId)) return;
  const timer = setTimeout(() => {
    completionRetryTimers.delete(callId);
    retryCompletion(callId);
  }, delay);
  completionRetryTimers.set(callId, timer);
}

async function retryCompletion(callId, announceFailure = false) {
  const pending = pendingCompletions.get(callId);
  if (!pending || completionRequests.has(callId)) return;
  completionRequests.add(callId);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await Auth.fetch(`${API}/calls/complete`, {
      method: 'POST',
      signal: controller.signal,
      body: JSON.stringify({
        client_call_id: pending.client_call_id,
        outcome: pending.outcome,
        caller_name: pending.caller_name
      })
    });
    const data = await res.json().catch(() => null);
    if (res.status === 409) {
      pendingCompletions.delete(callId);
      persistPendingCompletions();
      loadCalls();
      loadAnalytics();
      toast(data?.detail || 'The call already has a different saved outcome.', true);
      return;
    }
    if (!res.ok) {
      throw new Error(data?.detail || `HTTP ${res.status}`);
    }
    if (!data || data.outcome !== pending.outcome) {
      throw new Error('The saved outcome could not be confirmed.');
    }
    pendingCompletions.delete(callId);
    if (!persistPendingCompletions()) {
      pendingCompletions.set(callId, pending);
      throw new Error('The outcome was recorded, but local retry state could not be cleared.');
    }
    loadCalls();
    loadAnalytics();
    if (pending.attempts > 0) toast('Call outcome saved after retry.');
  } catch (error) {
    pending.attempts += 1;
    persistPendingCompletions();
    console.error('Could not confirm call outcome persistence.');
    if (announceFailure) {
      toast('Outcome is not yet confirmed by the database; it will retry automatically.', true);
    }
    scheduleCompletionRetry(callId, Math.min(60000, 2000 * (2 ** Math.min(pending.attempts - 1, 5))));
  } finally {
    clearTimeout(timeout);
    completionRequests.delete(callId);
  }
}

function reportOutcome(call, outcome) {
  if (!call) return;
  const pending = pendingCompletions.get(call.id);
  if (pending && pending.outcome !== outcome) {
    toast('A different outcome is already pending for this call.', true);
    return;
  }
  if (!pending) {
    pendingCompletions.set(call.id, {
      client_call_id: call.id,
      outcome,
      caller_name: call.name || null,
      attempts: 0
    });
    if (!persistPendingCompletions()) {
      toast('Outcome save is not durable in this browser; it will retry while this page remains open.', true);
    }
  }
  retryCompletion(call.id, true);
}

function finish(outcome, lines, event) {
  if (!event?.isTrusted) return;
  timers.forEach(clearTimeout); timers = [];
  const a = active; if (!a) return;
  reportOutcome(a, outcome);
  const savedTranscript = a.sensitiveInfoRequested
    ? lines.map(([speaker, text]) => speaker === 'caller' ? ['caller', '[Sensitive caller message redacted]'] : [speaker, text])
    : lines;
  state.calls.unshift({
    id: a.id, time: nowTime(), name: a.name, number: a.number, reason: a.reason,
    summary: a.summary || '', intent: a.intent, urgency: a.urgency, risk: a.risk,
    reviewRequired: a.reviewRequired, suggestedAction: a.suggestedAction,
    sensitiveInfoRequested: a.sensitiveInfoRequested,
    outcome, transcript: savedTranscript,
    trajectory: a.trajectory || [],
    sentiment: a.sentiment || (a.risk === 'High' ? 'Aggressive' : 'Neutral'),
    stress_level: a.stress_level ?? (a.risk === 'High' ? 85 : 25)
  });
  state.calls = state.calls.slice(0, 30);
  selectedCall = a.id; active = null; save();
  setPhase('idle'); renderCall(); renderDecision(); renderCalls();
  toast(`Simulated call ${outcome.toLowerCase()}`);
}

/* ---------- Call History from SQLite ---------- */
function mapDbCall(c) {
  const turns = c.turns || [];
  const lastTurn = turns.length ? turns[turns.length - 1] : null;
  let timeStr = '';
  try {
    timeStr = new Date(c.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    timeStr = c.started_at || '';
  }
  const transcript = [];
  const trajectory = [];
  turns.forEach((t, idx) => {
    const meta = {
      sentiment: t.sentiment || (idx === 0 && (t.risk === 'High' || c.intent === 'Possible scam') ? 'Aggressive' : 'Neutral'),
      stress_level: t.stress_level ?? (idx === 0 && (t.risk === 'High' || c.intent === 'Possible scam') ? 80 : 35)
    };
    if (t.caller_message) {
      transcript.push(['caller', t.caller_message, meta]);
      trajectory.push({ turn: trajectory.length + 1, sentiment: meta.sentiment, stress: meta.stress_level });
    }
    if (t.reply) {
      transcript.push(['ai', t.reply, { sentiment: 'Neutral' }]);
    }
  });
  return {
    id: c.id,
    name: c.caller_name || 'Unknown caller',
    time: timeStr,
    summary: lastTurn ? lastTurn.summary : (turns.length ? '' : 'Call ended before conversation.'),
    reason: lastTurn ? lastTurn.summary : '',
    outcome: c.outcome || 'In progress',
    transcript: transcript.length ? transcript : [['ai', 'No conversation turns recorded.']],
    trajectory,
    risk: lastTurn?.risk || 'Low',
    sentiment: lastTurn?.sentiment || (trajectory.length ? trajectory[trajectory.length - 1].sentiment : 'Neutral'),
    stress_level: lastTurn?.stress_level ?? (trajectory.length ? trajectory[trajectory.length - 1].stress : 25)
  };
}

async function loadCalls() {
  try {
    const res = await Auth.fetch(`${API}/calls`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data.calls)) {
      state.calls = data.calls.map(mapDbCall);
      save();
      renderCalls();
    }
  } catch (err) {
    console.error('Could not load calls from backend:', err);
  }
}

/* ---------- Renderers ---------- */
function renderCall() {
  $('#callEmpty').hidden = !!active; $('#callBody').hidden = !active;
  if (!active) return;
  $('#cAvatar').textContent = active.name[0]; $('#cName').textContent = active.name; $('#cNum').textContent = active.number;
  $('#cType').textContent = active.type === 'known' ? 'Known contact' : 'Unknown caller';
  $('#cReason').textContent = '“' + active.reason + '”';
  $('#liveTr').hidden = true; $('#liveTr').innerHTML = '';
  $('#chatBox').hidden = true; $('#chatInput').value = '';   // new call starts with a fresh conversation
  $$('.actions .btn', $('#callBody')).forEach(b => b.disabled = false);
}
function renderDecision() {
  $('#decEmpty').hidden = !!active; $('#decBody').hidden = !active;
  if (!active) return;
  $('#dIntent').textContent = active.intent; $('#dUrg').textContent = active.urgency; $('#dRisk').textContent = active.risk;
  $('#dAct').textContent = active.decision.recommendation
    ? RECOMMENDATION_LABEL[active.decision.recommendation]
    : ACTION_LABEL[active.decision.action];
  $('#dWhy').textContent = active.decision.why;

  // Sentiment & Stress Meter updates
  const sentiment = active.sentiment || (active.risk === 'High' ? 'Aggressive' : active.urgency === 'High' ? 'Frustrated' : 'Neutral');
  const dSent = $('#dSentiment');
  if (dSent) {
    dSent.textContent = sentiment;
    dSent.className = `tag tag-sentiment ${sentiment.toLowerCase()}`;
  }
  const stress = active.stress_level ?? (active.risk === 'High' ? 85 : active.urgency === 'High' ? 65 : 25);
  const bar = $('#dStressBar');
  const val = $('#dStressVal');
  if (bar) {
    bar.style.width = `${Math.min(100, Math.max(0, stress))}%`;
    bar.style.backgroundColor = stress >= 70 ? '#ff5c7a' : stress >= 40 ? '#ffb84d' : '#27e8ff';
  }
  if (val) val.textContent = `${stress}/100`;
}

function renderCalls() {
  const list = $('#callList');
  if (!state.calls.length) {
    list.innerHTML = '<div class="empty"><p>No calls yet.</p><button class="btn pri" data-act="simulate">Simulate incoming call</button></div>';
    $('#transcript').innerHTML = '<div class="empty">Nothing to show.</div>';
    AudioPlayer.loadCall(null);
    return;
  }
  if (!state.calls.find(c => c.id === selectedCall)) selectedCall = state.calls[0].id;
  list.innerHTML = state.calls.map(c => `
    <div class="item ${c.id === selectedCall ? 'sel' : ''}" data-call="${c.id}" tabindex="0">
      <div><b>${esc(c.name)}</b><small>${esc(c.summary || c.reason || 'No summary')}</small></div>
      <div><span class="tag">${esc(c.outcome)}</span><small>${esc(c.time)}</small></div>
    </div>
  `).join('');
  const c = state.calls.find(x => x.id === selectedCall), box = $('#transcript');
  box.innerHTML = '';
  if (c && c.transcript) {
    c.transcript.forEach((l, idx) => addMsg(box, l, idx));
  }
  AudioPlayer.loadCall(c);

  // Emotional & Stress Trajectory
  const trajBox = $('#callSentimentTrajectory');
  const trajTimeline = $('#trajTimeline');
  const trajSummary = $('#trajSummary');
  if (trajBox && trajTimeline && trajSummary) {
    const trajectory = (c && c.trajectory && c.trajectory.length) ? c.trajectory : [];
    if (trajectory.length > 0) {
      trajBox.hidden = false;
      const first = trajectory[0].sentiment;
      const last = trajectory[trajectory.length - 1].sentiment;
      trajSummary.textContent = trajectory.length > 1 ? `${first} ➔ ${last}` : `${first} (Stable)`;
      trajTimeline.innerHTML = trajectory.map((node, i) => `
        <div class="traj-node ${node.sentiment.toLowerCase()}">
          <span class="traj-badge">${esc(node.sentiment)}</span>
          <small class="traj-stress">${node.stress}% stress</small>
        </div>
        ${i < trajectory.length - 1 ? '<span class="traj-arrow" style="color:var(--mut);font-size:0.75rem">➔</span>' : ''}
      `).join('');
    } else if (c && c.transcript && c.transcript.length) {
      trajBox.hidden = false;
      const sent = c.risk === 'High' ? 'Aggressive' : 'Neutral';
      const stress = c.risk === 'High' ? 85 : 25;
      trajSummary.textContent = `${sent} (Detected)`;
      trajTimeline.innerHTML = `
        <div class="traj-node ${sent.toLowerCase()}">
          <span class="traj-badge">${sent}</span>
          <small class="traj-stress">${stress}% stress</small>
        </div>
      `;
    } else {
      trajBox.hidden = true;
    }
  }
}
function renderContacts() {
  const l = $('#contactList');
  if (!state.contacts.length) { l.innerHTML = '<div class="empty"><p>No contacts yet. Add one using the form.</p></div>'; return; }
  const P = { ring: 'Always ring', screen: 'AI screens', block: 'Blocked' };
  l.innerHTML = state.contacts.map(c => `<div class="item"><div><b>${esc(c.name)}</b><small>${esc(c.number)} · ${c.type}</small></div><div class="mini"><span class="tag">${P[c.pref]}</span><button class="btn" data-edit="${c.id}">Edit</button><button class="btn danger" data-del="${c.id}">Delete</button></div></div>`).join('');
}
function renderRules() {
  $('#ruleList').innerHTML = RULES.map(([k, t, d]) => `<label class="item row"><span><b>${t}</b><small>${d}</small></span><input type="checkbox" data-rule="${k}" ${state.rules[k] ? 'checked' : ''}></label>`).join('');
  const s = state.schedule;
  $('#schOn').checked = s.on; $('#schStart').value = s.start; $('#schEnd').value = s.end;
  $('#schState').textContent = s.on ? `Agent turns on at ${s.start} and off at ${s.end}.` : 'Schedule is off.';
}
 
/* ---------- Contacts form ---------- */
function onContactSubmit(e) {
  e.preventDefault();
  const name = $('#fName').value.trim(), number = $('#fNum').value.trim(), id = +$('#fId').value || 0, err = $('#fErr');
  if (name.length < 2) return err.textContent = 'Enter a name with at least 2 characters.';
  if (!/^\+?[\d\s()-]{7,18}$/.test(number) || digits(number).length < 7) return err.textContent = 'Enter a valid phone number, e.g. +91 98765 43210.';
  if (state.contacts.some(c => digits(c.number) === digits(number) && c.id !== id)) return err.textContent = 'That number is already saved.';
  err.textContent = '';
  const rec = { id: id || Date.now(), name, number, type: $('#fType').value, pref: $('#fPref').value };
  if (id) state.contacts = state.contacts.map(c => c.id === id ? rec : c); else state.contacts.push(rec);
  save(); renderContacts(); resetForm(); toast(id ? 'Contact updated' : 'Contact added');
}
function resetForm() { $('#contactForm').reset(); $('#fId').value = ''; $('#formTitle').textContent = 'Add contact'; $('#fErr').textContent = ''; }
 
/* ---------- Schedule ---------- */
const mins = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
function inWindow() {
  const d = new Date(), n = d.getHours() * 60 + d.getMinutes(), a = mins(state.schedule.start), b = mins(state.schedule.end);
  return a < b ? n >= a && n < b : n >= a || n < b;
}
function checkSchedule() {
  if (!state.schedule.on) return;
  if (inWindow() && !state.agentOn) { setAgent(true, true); scheduleTurnedOn = true; toast('Scheduled Agent Mode started'); }
  else if (!inWindow() && state.agentOn && scheduleTurnedOn) { setAgent(false, true); scheduleTurnedOn = false; toast('Scheduled Agent Mode ended'); }
}
function saveSchedule() {
  const s = $('#schStart').value, e = $('#schEnd').value;
  if (!s || !e) return $('#schErr').textContent = 'Choose both a start and an end time.';
  if (s === e) return $('#schErr').textContent = 'Start and end must be different.';
  $('#schErr').textContent = '';
  state.schedule = { on: $('#schOn').checked, start: s, end: e };
  save(); renderRules(); checkSchedule(); toast('Schedule saved');
}
 
/* ---------- Counters ---------- */
function updateStats(anim) {
  $$('[data-count]').forEach(el => {
    const to = state.stats[el.dataset.count], from = +el.textContent || 0;
    if (!anim || reduced || from === to) { el.textContent = to; return; }
    const t0 = performance.now();
    (function step(t) { const p = Math.min(1, (t - t0) / 700); el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(step); })(t0);
  });
}
 
/* ---------- Real Analytics & Exports ---------- */
async function loadAnalytics() {
  try {
    const res = await Auth.fetch(`${API}/analytics/summary`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    realAnalytics = data;
    renderAnalytics();
  } catch (err) {
    console.error('Could not load analytics:', err);
    const statusEl = $('#anStatus');
    if (statusEl) statusEl.textContent = 'Could not load live analytics from backend.';
  }
}

function renderAnalytics() {
  if (!realAnalytics) return;
  const data = realAnalytics;
  const statusEl = $('#anStatus');
  const cardsEl = $('#anCards');

  // Update Overview stats from real data
  state.stats.calls = data.totals?.calls ?? 0;
  state.stats.spam = data.declined_high_risk_calls ?? 0;
  state.stats.saved = data.totals?.calls_with_analysis ?? 0;
  state.stats.transfers = data.outcomes?.['Transferred'] ?? 0;
  updateStats(false);

  if (data.empty) {
    if (statusEl) statusEl.textContent = 'No calls recorded in database yet. Screen or simulate calls to see real metrics.';
    if (cardsEl) {
      cardsEl.innerHTML = `
        <div class="glass tilt stat"><b>0</b><span class="muted">Total calls</span></div>
        <div class="glass tilt stat"><b>0</b><span class="muted">Completed</span></div>
        <div class="glass tilt stat"><b>0</b><span class="muted">Turns analyzed</span></div>
        <div class="glass tilt stat"><b>—</b><span class="muted">Avg Gemini latency</span></div>
      `;
    }
    drawCharts();
    return;
  }

  const dateObj = new Date(data.generated_at);
  const timeStr = isNaN(dateObj.getTime()) ? data.generated_at : dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (statusEl) {
    statusEl.textContent = `Calculated from ${data.totals.calls} recorded calls in SQLite (last updated at ${timeStr}).`;
  }

  const latencyStr = data.avg_gemini_latency_ms !== null && data.avg_gemini_latency_ms !== undefined ? `${data.avg_gemini_latency_ms} ms` : '—';
  const completedRate = data.totals.calls > 0 ? `${Math.round((data.totals.completed / data.totals.calls) * 100)}%` : '0%';

  if (cardsEl) {
    cardsEl.innerHTML = `
      <div class="glass tilt stat"><b>${data.totals.calls}</b><span class="muted">Total calls</span></div>
      <div class="glass tilt stat"><b>${data.totals.completed} <small style="font-size:1rem;color:var(--mut)">(${completedRate})</small></b><span class="muted">Completed</span></div>
      <div class="glass tilt stat"><b>${data.declined_high_risk_calls}</b><span class="muted">High-risk declined</span></div>
      <div class="glass tilt stat"><b>${latencyStr}</b><span class="muted">Avg Gemini latency</span></div>
    `;
  }

  drawCharts();
}

async function exportData(kind) {
  try {
    toast(`Preparing ${kind} export…`);
    const res = await Auth.fetch(`${API}/export/${kind}`);
    if (!res.ok) {
      throw new Error(`Server returned HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="?([^"]+)"?/);
    const filename = match ? match[1] : `callguardian-${kind}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Downloaded ${filename}`);
  } catch (err) {
    console.error(`Export failed for ${kind}:`, err);
    toast(`Export failed: ${err.message}`, true);
  }
}

/* ---------- Charts (canvas, animated once per draw) ---------- */
let chartRaf = 0;
function drawCharts() {
  cancelAnimationFrame(chartRaf);
  const t0 = performance.now();
  (function step(t) {
    const p = reduced ? 1 : Math.min(1, (t - t0) / 800), e = 1 - Math.pow(1 - p, 3);
    drawBar(e); drawDonut(e);
    if (p < 1) chartRaf = requestAnimationFrame(step);
  })(t0);
}
function drawBar(e) {
  const c = $('#barChart'), x = c.getContext('2d'), W = c.width, H = c.height;
  x.clearRect(0, 0, W, H);
  const items = (realAnalytics && Array.isArray(realAnalytics.calls_per_day)) ? realAnalytics.calls_per_day : [];
  if (!items.length) {
    x.fillStyle = '#8b9bc4'; x.font = '14px Manrope,sans-serif'; x.textAlign = 'center';
    x.fillText('No call history recorded yet', W / 2, H / 2);
    return;
  }
  const maxCalls = Math.max(1, ...items.map(d => d.calls || 0));
  const max = maxCalls * 1.3;
  const bw = W / items.length;
  items.forEach((item, i) => {
    const v = item.calls || 0;
    let dayLabel = item.date;
    try {
      const dt = new Date(item.date + 'T00:00:00Z');
      dayLabel = dt.toLocaleDateString([], { weekday: 'short', timeZone: 'UTC' });
    } catch (err) {}
    const h = (v / max) * (H - 50) * e;
    const X = i * bw + bw * .2, Y = H - 28 - h;
    const g = x.createLinearGradient(0, Y, 0, H);
    g.addColorStop(0, '#27e8ff'); g.addColorStop(1, '#8a5cff');
    x.fillStyle = g; x.beginPath(); x.roundRect(X, Y, bw * .6, Math.max(2, h), 8); x.fill();
    x.fillStyle = '#8b9bc4'; x.font = '13px Manrope,sans-serif'; x.textAlign = 'center';
    x.fillText(dayLabel, X + bw * .3, H - 8);
    if (e > .9) {
      x.fillText(v, X + bw * .3, Math.min(Y - 6, H - 36));
    }
  });
}
function drawDonut(e) {
  const c = $('#donut'), x = c.getContext('2d'), W = c.width, H = c.height;
  x.clearRect(0, 0, W, H);
  const o = (realAnalytics && realAnalytics.outcomes) ? realAnalytics.outcomes : { 'AI handled': 0, 'Transferred': 0, 'Declined': 0 };
  const parts = [
    ['AI handled', o['AI handled'] || 0, '#27e8ff'],
    ['Transferred', o['Transferred'] || 0, '#8a5cff'],
    ['Declined', o['Declined'] || 0, '#ff5c7a']
  ];
  const tot = parts.reduce((s, p) => s + p[1], 0);
  if (tot === 0) {
    x.strokeStyle = 'rgba(140, 170, 255, .18)';
    x.lineWidth = 34;
    x.beginPath();
    x.arc(W / 2, H / 2, 85, 0, Math.PI * 2);
    x.stroke();
    x.fillStyle = '#8b9bc4';
    x.font = '500 16px Sora,sans-serif';
    x.textAlign = 'center';
    x.fillText('No calls yet', W / 2, H / 2 + 6);
    $('#legend').innerHTML = '<span class="muted">No call outcomes recorded yet</span>';
    return;
  }
  let a = -Math.PI / 2;
  parts.forEach(([, v, col]) => {
    if (v > 0) {
      const s = (v / tot) * Math.PI * 2 * e;
      x.strokeStyle = col;
      x.lineWidth = 34;
      x.beginPath();
      x.arc(W / 2, H / 2, 85, a, a + s);
      x.stroke();
      a += s;
    }
  });
  x.fillStyle = '#0f1b3d';
  x.font = '700 30px Sora,sans-serif';
  x.textAlign = 'center';
  x.fillText(Math.round(tot * e), W / 2, H / 2 + 8);
  $('#legend').innerHTML = parts.map(p => `<span><i style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${p[2]};margin-right:6px"></i>${p[0]} ${p[1]}</span>`).join('');
}
 
/* ---------- Visual engine: orb (Three.js) + background + waveform ---------- */
const PHASE_STYLE = { off: [0x5a6aa8, .25], on: [0x27e8ff, .55], ringing: [0x2f5bea, 1], handling: [0x3dffa8, .85] };
const mouse = { x: 0, y: 0 };
let orb = null, rafId = 0, running = false;
const bg = $('#bg'), bctx = bg.getContext('2d'), wv = $('#wave'), wctx = wv.getContext('2d');
let dots = [];
 
function initBg() {
  bg.width = innerWidth; bg.height = innerHeight;
  dots = Array.from({ length: innerWidth < 700 ? 35 : 80 }, () => ({ x: Math.random() * bg.width, y: Math.random() * bg.height, r: Math.random() * 1.6 + .4, v: Math.random() * .25 + .05, z: Math.random() }));
}
function drawBg() {
  bctx.clearRect(0, 0, bg.width, bg.height);
  dots.forEach(d => {
    d.y -= d.v; if (d.y < -5) { d.y = bg.height + 5; d.x = Math.random() * bg.width; }
    bctx.fillStyle = `rgba(${d.z > .5 ? '10,143,176' : '47,91,234'},${.25 + d.z * .4})`;
    bctx.beginPath(); bctx.arc(d.x + mouse.x * 20 * d.z, d.y + mouse.y * 20 * d.z, d.r, 0, 7); bctx.fill();
  });
}
function phaseKey() { const p = document.body.dataset.phase; return p === 'ringing' || p === 'handling' ? p : state.agentOn ? 'on' : 'off'; }
 
function initOrb() {
  const host = $('#orb');
  if (!window.THREE) return;   // fallback: CSS orb stays visible
  try {
    const T = THREE, r = new T.WebGLRenderer({ alpha: true, antialias: true });
    r.setPixelRatio(Math.min(devicePixelRatio, 2)); host.appendChild(r.domElement); host.classList.add('has-3d');
    const scene = new T.Scene(), cam = new T.PerspectiveCamera(45, 1, .1, 50); cam.position.z = 5.2;
    const group = new T.Group(); scene.add(group);
    const core = new T.Mesh(new T.SphereGeometry(1.05, 48, 48), new T.MeshBasicMaterial({ color: 0x27e8ff, transparent: true, opacity: .35 }));
    const wire = new T.Mesh(new T.IcosahedronGeometry(1.45, 2), new T.MeshBasicMaterial({ color: 0x27e8ff, wireframe: true, transparent: true, opacity: .35 }));
    const wire2 = new T.Mesh(new T.IcosahedronGeometry(1.9, 1), new T.MeshBasicMaterial({ color: 0x2f5bea, wireframe: true, transparent: true, opacity: .18 }));
    const N = 260, pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) { const a = Math.random() * 6.28, b = Math.acos(2 * Math.random() - 1), R = 2.2 + Math.random() * .6; pos.set([R * Math.sin(b) * Math.cos(a), R * Math.sin(b) * Math.sin(a), R * Math.cos(b)], i * 3); }
    const pg = new T.BufferGeometry(); pg.setAttribute('position', new T.BufferAttribute(pos, 3));
    const pts = new T.Points(pg, new T.PointsMaterial({ color: 0x3a7bd5, size: .035, transparent: true, opacity: .8 }));
    group.add(core, wire, wire2, pts);
    orb = { r, scene, cam, group, core, wire, wire2, pts, color: new T.Color(0x5a6aa8), energy: .25, spin: 0 };
    resizeOrb();
  } catch (err) { orb = null; $('#orb').classList.remove('has-3d'); toast('3D unavailable; showing 2D orb.', true); }
}
function resizeOrb() {
  if (!orb) return; const s = $('#orb').clientWidth; if (!s) return;
  orb.r.setSize(s, s); orb.cam.aspect = 1; orb.cam.updateProjectionMatrix();
}
function drawOrb(t) {
  const [col, en] = PHASE_STYLE[phaseKey()], o = orb;
  o.color.lerp(new THREE.Color(col), .06); o.energy += (en - o.energy) * .06;
  o.core.material.color.copy(o.color); o.wire.material.color.copy(o.color);
  const s = t / 1000, pulse = 1 + Math.sin(s * (2 + o.energy * 5)) * .04 * (.4 + o.energy);
  o.core.scale.setScalar(pulse); o.wire.scale.setScalar(1 + (pulse - 1) * .6);
  o.core.material.opacity = .22 + o.energy * .25;
  o.group.rotation.y += .003 + o.energy * .01; o.group.rotation.x += (mouse.y * .35 - o.group.rotation.x) * .04;
  o.wire2.rotation.z -= .004; o.pts.rotation.y -= .002 + o.energy * .004;
  o.group.position.x += (mouse.x * .25 - o.group.position.x) * .05;
  o.r.render(o.scene, o.cam);
}
function drawWave(t) {
  const W = wv.width, H = wv.height, k = phaseKey(), amp = k === 'off' ? .08 : k === 'on' ? .22 : k === 'ringing' ? .7 : .55;
  const col = { off: '#5a6aa8', on: '#0a8fb0', ringing: '#2f5bea', handling: '#12a56b' }[k];
  wctx.clearRect(0, 0, W, H); wctx.fillStyle = col;
  for (let i = 0; i < 48; i++) {
    const v = (Math.sin(t / 220 + i * .6) * .5 + .5) * (Math.sin(t / 530 + i * .21) * .5 + .5) * amp + .03, h = v * H;
    wctx.fillRect(i * (W / 48) + 2, (H - h) / 2, W / 48 - 5, h);
  }
}
function frame(t) {
  drawBg();
  if ($('#overview').classList.contains('on')) { if (orb) drawOrb(t); drawWave(t); }
}
function loop(t) { if (!running) return; frame(t); rafId = requestAnimationFrame(loop); }
function start() { if (reduced || running || document.hidden) return; running = true; rafId = requestAnimationFrame(loop); }
function stop() { running = false; cancelAnimationFrame(rafId); }
function kick() { if (reduced) requestAnimationFrame(frame); else start(); }  // reduced motion: draw single frames on change
 
/* ---------- Tilt cards ---------- */
function initTilt() {
  document.addEventListener('pointermove', e => {
    mouse.x = e.clientX / innerWidth * 2 - 1; mouse.y = e.clientY / innerHeight * 2 - 1;
    if (reduced || e.pointerType === 'touch') return;
    const el = e.target.closest && e.target.closest('.tilt');
    $$('.tilt').forEach(c => { if (c !== el) c.style.transform = ''; });
    if (!el) return;
    const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5;
    el.style.transform = `perspective(900px) rotateX(${(-y * 7).toFixed(2)}deg) rotateY(${(x * 9).toFixed(2)}deg) translateZ(6px)`;
  });
  document.addEventListener('pointerleave', () => $$('.tilt').forEach(c => c.style.transform = ''));
}
 
/* ---------- Motion preference ---------- */
function applyMotion() {
  reduced = matchMedia('(prefers-reduced-motion: reduce)').matches || state.reduce;
  document.body.classList.toggle('reduce', reduced);
  const motionSetting = $('#setMotion');
  if (motionSetting) motionSetting.checked = state.reduce;
  if (reduced) { stop(); kick(); } else start();
}
 
/* ---------- Knowledge Vault & Caller CRM ---------- */
async function loadVault() {
  try {
    const res = await Auth.fetch(`${API}/vault`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = $('#vaultList');
    if (!list) return;
    if (!data.rules || !data.rules.length) {
      list.innerHTML = '<div class="empty"><p>No custom vault rules set yet. Add preferences or policies above.</p></div>';
      return;
    }
    list.innerHTML = data.rules.map(r => `
      <div class="vault-card" data-rule="${r.id}" style="display:flex;align-items:center;justify-content:space-between;padding:12px;margin-bottom:8px;background:rgba(255,255,255,0.04);border-radius:12px;border:1px solid var(--line);gap:12px">
        <div style="flex:1">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <span class="tag vault-cat-badge ${r.category}" style="font-size:0.72rem;text-transform:capitalize">${esc(r.category)}</span>
            <small class="muted" style="font-size:0.75rem">${new Date(r.created_at).toLocaleDateString()}</small>
          </div>
          <p style="margin:0;font-size:0.92rem;color:var(--tx)">${esc(r.rule_text)}</p>
        </div>
        <div class="mini" style="display:flex;gap:6px">
          <button class="btn ${r.is_active ? 'btn-active' : ''}" data-toggle-vault="${r.id}" type="button" style="padding:4px 10px;font-size:0.78rem">
            ${r.is_active ? 'Active' : 'Paused'}
          </button>
          <button class="btn danger" data-del-vault="${r.id}" type="button" style="padding:4px 8px;font-size:0.78rem">Delete</button>
        </div>
      </div>
    `).join('');
  } catch (e) {
    console.error('Failed to load vault rules:', e);
  }
}

async function loadCRM() {
  try {
    const res = await Auth.fetch(`${API}/crm`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = $('#crmList');
    if (!list) return;
    if (!data.contacts || !data.contacts.length) {
      list.innerHTML = '<div class="empty"><p>No recurring caller memories recorded yet. The agent logs caller details as conversations occur.</p></div>';
      return;
    }
    list.innerHTML = data.contacts.map(c => `
      <div class="crm-card" style="padding:12px;margin-bottom:10px;background:rgba(255,255,255,0.04);border-radius:12px;border:1px solid var(--line)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <b>${esc(c.caller_name)}</b>
          <span class="tag">${esc(c.relationship || 'Contact')}</span>
        </div>
        <div style="font-size:0.8rem;color:var(--mut);margin-bottom:8px">
          Last active: ${c.last_call_at ? new Date(c.last_call_at).toLocaleString() : 'Recently'}
        </div>
        <label style="font-size:0.8rem;color:var(--mut);display:block;margin-bottom:4px">Caller Memory & Notes:</label>
        <div style="display:flex;gap:8px">
          <input class="crm-notes-input" data-caller="${esc(c.caller_name)}" value="${esc(c.notes || '')}" placeholder="e.g., Dr. Patel following up on Tuesday test results" style="flex:1">
          <button class="btn btn-save-crm" data-caller="${esc(c.caller_name)}" type="button" style="padding:6px 12px;font-size:0.8rem">Save</button>
        </div>
      </div>
    `).join('');
  } catch (e) {
    console.error('Failed to load CRM:', e);
  }
}

async function checkNvidiaStatus() {
  const tag = $('#nvStatusTag');
  const text = $('#nvStatusText');
  if (!tag || !text) return;
  try {
    const res = await Auth.fetch(`${API}/tts/status`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (data.nvidia_configured || data.nvidia_api_configured) {
      window.CGAI_NVIDIA_ONLINE = true;
      tag.textContent = 'Connected (NVIDIA NIM)';
      tag.className = 'tag';
      tag.style.background = 'rgba(61,255,168,0.15)';
      tag.style.color = '#3dffa8';
      tag.style.borderColor = 'rgba(61,255,168,0.4)';
      text.textContent = `Model: ${data.model} · Ready for speech synthesis`;
    } else {
      tag.textContent = 'Fallback (Web Speech)';
      tag.className = 'tag';
      tag.style.background = 'rgba(255,184,77,0.15)';
      tag.style.color = '#ffb84d';
      tag.style.borderColor = 'rgba(255,184,77,0.4)';
      text.textContent = 'NVIDIA_API_KEY not configured in .env. Using browser natural voices.';
    }
  } catch (err) {
    tag.textContent = 'Offline';
    text.textContent = 'Could not query TTS engine status.';
  }
}

/* ---------- Wire up events ---------- */
function bind() {
  document.addEventListener('click', e => {
    const goBtn = e.target.closest('[data-go]');
    if (goBtn) {
      const targetView = goBtn.dataset.go;
      if (targetView) {
        go(targetView);
        return;
      }
    }
    const exp = e.target.closest('[data-export]');
    if (exp) { exportData(exp.dataset.export); return; }
    const sp = e.target.closest('[data-speak]');
    if (sp) {
      if (sp.dataset.turnIdx !== undefined) {
        AudioPlayer.seekToTurn(+sp.dataset.turnIdx);
      } else {
        TTS.speak(sp.closest('.msg').dataset.text, true);
      }
      return;
    }
    const a = e.target.closest('[data-act]');
    if (a) { const k = a.dataset.act; if (k === 'simulate') { if (!$('#overview').classList.contains('on')) go('overview'); simulate(); } else act(k, e); return; }
    const c = e.target.closest('[data-call]');
    if (c) { selectedCall = +c.dataset.call; renderCalls(); return; }
    const ed = e.target.closest('[data-edit]');
    if (ed) { const k = state.contacts.find(x => x.id === +ed.dataset.edit); if (k) { $('#fId').value = k.id; $('#fName').value = k.name; $('#fNum').value = k.number; $('#fType').value = k.type; $('#fPref').value = k.pref; $('#formTitle').textContent = 'Edit contact'; $('#fName').focus(); } return; }
    const del = e.target.closest('[data-del]');
    if (del) { state.contacts = state.contacts.filter(x => x.id !== +del.dataset.del); save(); renderContacts(); toast('Contact deleted'); return; }

    const togV = e.target.closest('[data-toggle-vault]');
    if (togV) {
      const id = +togV.dataset.toggleVault;
      Auth.fetch(`${API}/vault/${id}/toggle`, { method: 'POST' }).then(() => {
        loadVault();
        toast('Vault rule updated');
      }).catch(() => toast('Could not toggle rule', true));
      return;
    }

    const delV = e.target.closest('[data-del-vault]');
    if (delV) {
      const id = +delV.dataset.delVault;
      Auth.fetch(`${API}/vault/${id}`, { method: 'DELETE' }).then(() => {
        loadVault();
        toast('Vault rule deleted');
      }).catch(() => toast('Could not delete rule', true));
      return;
    }

    const saveCrm = e.target.closest('.btn-save-crm');
    if (saveCrm) {
      const caller = saveCrm.dataset.caller;
      const input = document.querySelector(`.crm-notes-input[data-caller="${caller}"]`);
      if (input) {
        Auth.fetch(`${API}/crm`, {
          method: 'POST',
          body: JSON.stringify({ caller_name: caller, notes: input.value.trim(), relationship: 'Contact' })
        }).then(() => toast(`Saved memory notes for ${caller}`))
          .catch(() => toast('Could not save CRM notes', true));
      }
      return;
    }
  });

  $('#nav').addEventListener('click', e => { const b = e.target.closest('button'); if (b) go(b.dataset.go); });
  $('#heroLaunchSimBtn')?.addEventListener('click', () => go('overview'));
  $('#compLaunchSimBtn')?.addEventListener('click', () => go('overview'));
  $('#heroQuickMicBtn')?.addEventListener('click', () => {
    go('overview');
    setTimeout(() => {
      const mic = $('#micBtn');
      if (mic) { mic.focus(); mic.click(); }
    }, 300);
  });
  $('#agentToggle').addEventListener('change', e => { setAgent(e.target.checked); toast(e.target.checked ? 'Agent Mode on' : 'Agent Mode off'); });
  // Logout
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) logoutBtn.addEventListener('click', () => Auth.logout());
  document.addEventListener('keydown', e => { const c = e.target.closest && e.target.closest('[data-call]'); if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectedCall = +c.dataset.call; renderCalls(); } });
  $('#contactForm').addEventListener('submit', onContactSubmit);
  $('#fReset').addEventListener('click', resetForm);
  $('#schSave').addEventListener('click', saveSchedule);
  $('#ruleList').addEventListener('change', e => { const k = e.target.dataset.rule; if (k) { state.rules[k] = e.target.checked; save(); toast('Rule updated'); } });
  $('#setMotion')?.addEventListener('change', e => { state.reduce = e.target.checked; save(); applyMotion(); });
  $('#setVoice')?.addEventListener('change', e => { state.voice = e.target.value; save(); toast('Voice style: ' + e.target.value); });

  $('#vaultForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const category = $('#vCategory').value;
    const rule_text = $('#vText').value.trim();
    if (!rule_text) return;
    try {
      const res = await Auth.fetch(`${API}/vault`, {
        method: 'POST',
        body: JSON.stringify({ category, rule_text })
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      $('#vText').value = '';
      loadVault();
      toast('Rule added to Personal Knowledge Vault');
    } catch (err) {
      toast('Failed to add vault rule: ' + err.message, true);
    }
  });

  $('#testVoiceBtn')?.addEventListener('click', () => {
    TTS.speak('Hello! This is CallGuardian AI powered by NVIDIA voice synthesis.', true);
  });
  $('#sVoice')?.addEventListener('change', e => {
    state.nvidiaVoice = e.target.value;
    save();
    toast('NVIDIA voice persona updated');
  });
  $('#autoMicSend')?.addEventListener('change', e => {
    state.autoMicSend = e.target.checked;
    save();
  });
  $('#voicePlayback')?.addEventListener('change', e => {
    state.voicePlayback = e.target.checked;
    save();
  });

  $('#resetData')?.addEventListener('click', () => { TTS.stop(); timers.forEach(clearTimeout); active = null; state = DEFAULTS(); save(); init(); toast('Demo data reset'); });
  addEventListener('resize', () => { initBg(); resizeOrb(); kick(); });
  document.addEventListener('visibilitychange', () => document.hidden ? stop() : applyMotion());
  addEventListener('pagehide', () => { stop(); TTS.stop(); timers.forEach(clearTimeout); });
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', applyMotion);
}

/* ═════════════════════════════════════════════════════════════════════
   Lenis Smooth Scrolling & Anime.js Kinetic Engine
   ═════════════════════════════════════════════════════════════════════ */
let lenisInstance = null;
function initLenis() {
  if (typeof window.Lenis === 'undefined') return;
  try {
    lenisInstance = new window.Lenis({
      duration: 1.2,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: true,
      smoothTouch: false,
      direction: 'vertical'
    });
    function raf(time) {
      if (lenisInstance) lenisInstance.raf(time);
      requestAnimationFrame(raf);
    }
    requestAnimationFrame(raf);
  } catch (err) {
    console.warn('Lenis initialization notice:', err);
  }
}

let metricsAnimated = false;
function animateMetricCounters(force = false) {
  if (metricsAnimated && !force) return;
  metricsAnimated = true;
  if (typeof window.anime === 'undefined') return;

  const scam = $('#metricScam');
  if (scam) {
    const scamObj = { val: 0 };
    anime({
      targets: scamObj,
      val: 99.8,
      round: 10,
      duration: 1800,
      easing: 'easeOutExpo',
      update: () => { scam.textContent = scamObj.val.toFixed(1); }
    });
  }

  const latency = $('#metricLatency');
  if (latency) {
    const latObj = { val: 800 };
    anime({
      targets: latObj,
      val: 240,
      round: 1,
      duration: 1600,
      easing: 'easeOutExpo',
      update: () => { latency.textContent = Math.round(latObj.val); }
    });
  }

  const rag = $('#metricRAG');
  if (rag) {
    const ragObj = { val: 0 };
    anime({
      targets: ragObj,
      val: 100,
      round: 1,
      duration: 1700,
      easing: 'easeOutExpo',
      update: () => { rag.textContent = Math.round(ragObj.val); }
    });
  }

  const uptime = $('#metricUptime');
  if (uptime) {
    const upObj = { val: 0 };
    anime({
      targets: upObj,
      val: 24,
      round: 1,
      duration: 1400,
      easing: 'easeOutExpo',
      update: () => { uptime.textContent = Math.round(upObj.val); }
    });
  }
}

function initDraggableThreatDial() {
  const track = $('#threatTrack');
  const handle = $('#threatHandle');
  const fill = $('#threatFill');
  const badge = $('#threatLevelBadge');
  const statusText = $('#threatStatusText');
  const morphCore = $('#heroMorphShape');
  if (!track || !handle) return;

  let isDragging = false;
  let currentPct = 24;

  function updateThreatUI(pct, withSpring = false) {
    currentPct = Math.max(0, Math.min(100, pct));
    handle.style.left = `${currentPct}%`;
    fill.style.width = `${currentPct}%`;
    handle.setAttribute('aria-valuenow', Math.round(currentPct));

    if (currentPct <= 35) {
      badge.className = 'threat-badge safe';
      badge.textContent = `NORMAL (${Math.round(currentPct)}%)`;
      statusText.textContent = 'Passive Screening: Legitimate calls pass in <180ms';
      if (morphCore) morphCore.setAttribute('stroke', '#3dffa8');
    } else if (currentPct <= 70) {
      badge.className = 'threat-badge elevated';
      badge.textContent = `ELEVATED (${Math.round(currentPct)}%)`;
      statusText.textContent = 'Active Interrogation: Requiring caller identity verification';
      if (morphCore) morphCore.setAttribute('stroke', '#ffbb27');
    } else {
      badge.className = 'threat-badge critical';
      badge.textContent = `CRITICAL (${Math.round(currentPct)}%)`;
      statusText.textContent = 'Emergency Defense: Auto-dropping spoofed VoIP bots & scam scripts';
      if (morphCore) morphCore.setAttribute('stroke', '#ff5c7a');
    }

    if (withSpring && typeof window.anime !== 'undefined') {
      anime({
        targets: handle,
        scale: [1.25, 1],
        duration: 500,
        easing: 'spring(1, 80, 10, 0)'
      });
      anime({
        targets: badge,
        scale: [1.12, 1],
        duration: 400,
        easing: 'spring(1, 90, 10, 0)'
      });
    }
  }

  function onPointerMove(e) {
    if (!isDragging) return;
    const rect = track.getBoundingClientRect();
    const clientX = e.clientX || (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
    const pct = ((clientX - rect.left) / rect.width) * 100;
    updateThreatUI(pct, false);
  }

  function onPointerUp() {
    if (!isDragging) return;
    isDragging = false;
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerUp);
    updateThreatUI(currentPct, true);
  }

  handle.addEventListener('pointerdown', (e) => {
    isDragging = true;
    e.preventDefault();
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerUp);
  });

  track.addEventListener('click', (e) => {
    const rect = track.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    updateThreatUI(pct, true);
  });

  handle.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      updateThreatUI(currentPct + 5, true);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      updateThreatUI(currentPct - 5, true);
    }
  });

  updateThreatUI(24, false);
}

function initScrollObserver() {
  if (typeof window.IntersectionObserver === 'undefined') {
    animateMetricCounters();
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        if (entry.target.classList.contains('hero-metrics-grid') || entry.target.dataset.metric) {
          animateMetricCounters();
          if (typeof window.anime !== 'undefined') {
            anime({
              targets: '.metric-card',
              opacity: [0, 1],
              translateY: [35, 0],
              scale: [0.93, 1],
              delay: anime.stagger(100, { start: 100, from: 'first' }),
              duration: 750,
              easing: 'easeOutCubic'
            });
          }
        }
        if (entry.target.classList.contains('hero-pipeline-showcase')) {
          if (typeof window.anime !== 'undefined') {
            anime({
              targets: '.stagger-step',
              opacity: [0, 1],
              translateY: [30, 0],
              delay: anime.stagger(120, { start: 150, from: 'first' }),
              duration: 700,
              easing: 'easeOutCubic'
            });
          }
        }
        if (entry.target.classList.contains('hero-comparison-showcase')) {
          if (typeof window.anime !== 'undefined') {
            anime({
              targets: '.comparison-card',
              opacity: [0, 1],
              translateY: [28, 0],
              delay: anime.stagger(140, { start: 100, from: 'first' }),
              duration: 750,
              easing: 'easeOutCubic'
            });
          }
        }
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15 });

  const metricsGrid = $('.hero-metrics-grid');
  if (metricsGrid) observer.observe(metricsGrid);
  const pipelineShowcase = $('.hero-pipeline-showcase');
  if (pipelineShowcase) observer.observe(pipelineShowcase);
  const comparisonShowcase = $('.hero-comparison-showcase');
  if (comparisonShowcase) observer.observe(comparisonShowcase);
}

function initInteractiveCardsMotion() {
  if (typeof window.anime === 'undefined') return;

  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  if (!isMobile) {
    $$('.metric-card, .pipeline-step-card, .comparison-card').forEach(card => {
      card.addEventListener('mouseenter', () => {
        anime({
          targets: card,
          translateY: -5,
          scale: 1.015,
          duration: 350,
          easing: 'spring(1, 80, 12, 0)'
        });
      });
      card.addEventListener('mouseleave', () => {
        anime({
          targets: card,
          translateY: 0,
          scale: 1,
          duration: 450,
          easing: 'spring(1, 90, 10, 0)'
        });
      });
    });
  }
}

function initAnimeHero() {
  if (typeof window.anime === 'undefined') return;

  // 1. TIMELINE API: Hero Entrance Timeline
  const heroTl = anime.timeline({
    easing: 'easeOutExpo',
    duration: 800
  });

  heroTl
    .add({
      targets: '.hero-badge-pill',
      opacity: [0, 1],
      translateY: [-24, 0],
      duration: 600
    })
    .add({
      targets: '.hero-word',
      opacity: [0, 1],
      translateY: [32, 0],
      rotateX: [25, 0],
      delay: anime.stagger(50),
      duration: 650
    }, '-=350')
    .add({
      targets: '.hero-lead-text',
      opacity: [0, 1],
      translateY: [20, 0],
      duration: 550
    }, '-=350')
    .add({
      targets: '.hero-cta-btn',
      opacity: [0, 1],
      translateY: [16, 0],
      scale: [0.92, 1],
      delay: anime.stagger(80),
      duration: 700,
      easing: 'spring(1, 80, 10, 0)'
    }, '-=350')
    .add({
      targets: '.hero-interactive-stage',
      opacity: [0, 1],
      translateY: [28, 0],
      duration: 750
    }, '-=300');

  $('#heroReplayTimelineBtn')?.addEventListener('click', () => {
    heroTl.restart();
    animateMetricCounters(true);
  });

  $('#heroLaunchSimBtn')?.addEventListener('click', () => {
    go('overview');
  });
  $('#heroQuickMicBtn')?.addEventListener('click', () => {
    go('overview');
    setTimeout(() => {
      const mic = $('#micBtn');
      if (mic) {
        mic.focus();
        mic.click();
      }
    }, 300);
  });
  $('#compLaunchSimBtn')?.addEventListener('click', () => {
    go('overview');
  });

  // 2. LINE DRAWING: SVG Circuit paths
  anime({
    targets: '.line-draw-path',
    strokeDashoffset: [anime.setDashoffset, 0],
    easing: 'easeInOutSine',
    duration: 3200,
    delay: function(el, i) { return i * 350; },
    direction: 'alternate',
    loop: true
  });

  // 3. SHAPE MORPHING: Central Morph Core Path
  const SHAPES = {
    shield: 'M 100,20 C 145,20 180,45 180,95 C 180,145 140,175 100,190 C 60,175 20,145 20,95 C 20,45 55,20 100,20 Z',
    wave: 'M 100,30 C 160,35 175,85 140,110 C 185,135 155,180 100,165 C 45,180 15,135 60,110 C 25,85 40,35 100,30 Z',
    vault: 'M 100,20 C 150,20 165,60 165,100 C 165,140 150,180 100,180 C 50,180 35,140 35,100 C 35,60 50,20 100,20 Z'
  };

  const morphBtns = $$('.morph-btn');
  morphBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      morphBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const shape = btn.dataset.shape;
      if (SHAPES[shape]) {
        anime({
          targets: '#heroMorphShape',
          d: [{ value: SHAPES[shape] }],
          easing: 'easeInOutQuint',
          duration: 900
        });
        anime({
          targets: '#heroMorphShape',
          scale: [0.94, 1.03, 1],
          easing: 'spring(1, 80, 10, 0)',
          duration: 700
        });
      }
    });
  });

  // 4. MOTION PATHS: Signal Packets traveling along curved SVG spline
  const motionPath = anime.path('#signalMotionPath');
  if (motionPath) {
    anime({
      targets: '#signalPacket1',
      translateX: motionPath('x'),
      translateY: motionPath('y'),
      rotate: motionPath('angle'),
      easing: 'linear',
      duration: 3800,
      loop: true
    });
    anime({
      targets: '#signalPacket2',
      translateX: motionPath('x'),
      translateY: motionPath('y'),
      rotate: motionPath('angle'),
      easing: 'linear',
      duration: 4500,
      delay: 1100,
      loop: true
    });
    anime({
      targets: '#signalPacket3',
      translateX: motionPath('x'),
      translateY: motionPath('y'),
      rotate: motionPath('angle'),
      easing: 'linear',
      duration: 5200,
      delay: 2400,
      loop: true
    });
  }

  initDraggableThreatDial();
  initScrollObserver();
  initInteractiveCardsMotion();
}

/* ---------- Init ---------- */
function init() {
  setPhase('idle'); setAgent(state.agentOn, true);
  const voiceSetting = $('#setVoice');
  if (voiceSetting) voiceSetting.value = state.voice;
  const sVoice = $('#sVoice');
  if (sVoice) sVoice.value = state.nvidiaVoice || 'alloy';
  const autoMic = $('#autoMicSend');
  if (autoMic) autoMic.checked = state.autoMicSend !== false;
  const vp = $('#voicePlayback');
  if (vp) vp.checked = state.voicePlayback !== false;

  renderCall(); renderDecision(); renderCalls(); renderContacts(); renderRules(); updateStats(false);
  loadCalls(); loadAnalytics(); checkNvidiaStatus();
  pendingCompletions.forEach((_, callId) => retryCompletion(callId, true));
  initLenis();
  initAnimeHero();
  go('heroLanding'); applyMotion();
}
bind(); initBg(); initTilt(); initOrb(); TTS.init(); MicInput.init(); AudioPlayer.init(); bindChat(); init();
Auth.init();   // load /auth/me → populate user panel
addEventListener('online', () => pendingCompletions.forEach((_, callId) => retryCompletion(callId)));
setInterval(checkSchedule, 20000); checkSchedule();
