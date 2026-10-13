import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, AudioLines, Check, CircleStop, Clock3, Headphones, LoaderCircle, MicOff, Phone, RotateCcw, Send, ShieldCheck, Volume2, X } from 'lucide-react';
import { api, jsonBody, type Analysis } from '../lib/api';
import { useToast } from '../lib/toast';
import { EmptyState } from '../components/Common';

type Message = { role: 'caller' | 'assistant'; content: string; analysis?: Analysis };
type Outcome = 'AI handled' | 'Transferred' | 'Declined';

function formatElapsed(seconds: number) { return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }

export function AssistantPage() {
  const [callerName, setCallerName] = useState('Unknown caller');
  const [active, setActive] = useState(false);
  const [callId, setCallId] = useState<number | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [ending, setEnding] = useState(false);
  const [elapsedSpeech, setElapsedSpeech] = useState(false);
  const [apiStatus, setApiStatus] = useState<'checking' | 'configured' | 'missing' | 'unavailable'>('checking');
  const messageEnd = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const notify = useToast();
  const navigate = useNavigate();

  useEffect(() => { api<{ gemini_key_configured: boolean }>('/config-status').then((result) => setApiStatus(result.gemini_key_configured ? 'configured' : 'missing')).catch(() => setApiStatus('unavailable')); }, []);
  useEffect(() => { messageEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages, busy]);
  useEffect(() => {
    if (!active || !startedAt) return;
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    tick(); const timer = window.setInterval(tick, 1000); return () => window.clearInterval(timer);
  }, [active, startedAt]);
  useEffect(() => () => { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); }, []);

  const start = () => {
    const id = Date.now(); const time = Date.now();
    setCallId(id); setStartedAt(time); setElapsed(0); setMessages([]); setActive(true); setEnding(false); setDraft('');
    notify('Simulation started. Type what the caller says to get an AI response.', 'success');
    window.setTimeout(() => inputRef.current?.focus(), 60);
  };

  const sendMessage = async (event?: React.FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!active || !callId || !text || busy) return;
    if (text.length > 2000) { notify('Keep each caller message under 2,000 characters.', 'error'); return; }
    setBusy(true);
    try {
      const history = messages.map((item) => ({ role: item.role, content: item.content }));
      const result = await api<Analysis>('/chat', jsonBody({ message: text, history, client_call_id: callId, caller_name: callerName.trim() || 'Unknown caller' }));
      setMessages((current) => [...current, { role: 'caller', content: text }, { role: 'assistant', content: result.reply, analysis: result }]);
      setDraft('');
    } catch (reason) { notify(reason instanceof Error ? reason.message : 'The assistant could not respond.', 'error'); }
    finally { setBusy(false); inputRef.current?.focus(); }
  };

  const endCall = async (outcome: Outcome) => {
    if (!callId || ending) return;
    setEnding(true);
    try {
      await api('/calls/complete', jsonBody({ client_call_id: callId, outcome, caller_name: callerName.trim() || 'Unknown caller' }));
      setActive(false); setCallId(null); setStartedAt(null); setMessages([]);
      notify(`Simulation saved as “${outcome}”.`, 'success');
      navigate('/calls');
    } catch (reason) { notify(reason instanceof Error ? reason.message : 'Could not save this call outcome.', 'error'); }
    finally { setEnding(false); }
  };

  const retrySpeech = (text: string) => {
    if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) { notify('Speech playback is not supported in this browser.', 'error'); return; }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-IN'; utterance.onstart = () => setElapsedSpeech(true); utterance.onend = () => setElapsedSpeech(false);
    utterance.onerror = () => { setElapsedSpeech(false); notify('Browser speech could not play. The response remains available as text.', 'error'); };
    window.speechSynthesis.speak(utterance);
  };

  return <div className="page-stack assistant-page">
    <div className="assistant-intro"><div><span className="eyebrow">TEXT-BASED CALL SIMULATION</span><h2>Practice a safer response.</h2><p>This creates a simulated record. It does not connect to a phone, microphone, or carrier.</p></div><div className={`model-status model-${apiStatus}`}><i />{apiStatus === 'checking' ? 'Checking backend' : apiStatus === 'missing' ? 'Gemini key not configured' : apiStatus === 'unavailable' ? 'Backend unavailable' : 'Gemini key configured'}</div></div>
    <div className="simulation-layout">
      <section className="panel simulation-panel">
        <div className="simulation-topline"><div className="simulation-title"><span className="simulation-mark"><AudioLines size={18} /></span><div><strong>Call simulation</strong><small>Gemini text response · browser speech optional</small></div></div><div className="simulation-top-actions">{active ? <span className="live-chip"><i /> SESSION ACTIVE</span> : <span className="idle-chip"><i /> READY</span>}</div></div>
        {!active ? <div className="simulation-start"><div className="start-illustration"><div className="start-ring start-ring-one" /><div className="start-ring start-ring-two" /><div className="start-center"><Headphones size={31} /></div><span className="start-dot start-dot-a" /><span className="start-dot start-dot-b" /><span className="start-dot start-dot-c" /></div><h3>Start a new simulation</h3><p>Type caller messages, review the AI’s suggestions, and save an outcome to your call history.</p><div className="form-field simulation-caller"><label htmlFor="caller-name">Caller label</label><input id="caller-name" value={callerName} onChange={(event) => setCallerName(event.target.value)} maxLength={80} placeholder="Unknown caller" /></div><button className="button button-primary start-call-button" onClick={start}><Phone size={17} /> Start simulation</button><div className="simulation-disclaimer"><ShieldCheck size={15} /> Simulation only — no real phone call is started.</div></div> : <>
          <div className="call-session-bar"><span className="session-person"><span className="caller-avatar"><Phone size={15} /></span><span><strong>{callerName || 'Unknown caller'}</strong><small>Simulated session</small></span></span><span className="session-timer"><Clock3 size={15} />{formatElapsed(elapsed)}</span><button className="icon-button end-session-icon" onClick={() => setEnding(true)} aria-label="End simulation"><X size={17} /></button></div>
          <div className="transcript" aria-live="polite">
            {!messages.length && !busy && <div className="transcript-empty"><div className="sound-wave"><i /><i /><i /><i /><i /></div><strong>Simulation is ready</strong><p>Enter the caller’s words below. The assistant will analyze the message.</p></div>}
            {messages.map((message, index) => <div className={`message-row message-${message.role}`} key={`${index}-${message.role}`}><span className={`message-avatar ${message.role === 'assistant' ? 'assistant-avatar' : ''}`}>{message.role === 'assistant' ? <ShieldCheck size={16} /> : <Phone size={14} />}</span><div className="message-body"><div className="message-meta"><strong>{message.role === 'assistant' ? 'Guardian assistant' : callerName || 'Caller'}</strong><span>{new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div><div className="message-bubble">{message.content}</div>{message.analysis && <div className="analysis-mini"><span>{message.analysis.intent}</span><span className={`risk-${message.analysis.risk.toLowerCase()}`}>{message.analysis.risk} risk</span>{message.analysis.review_required && <span className="review-tag"><AlertTriangle size={12} /> Review</span>}<button className="speech-button" onClick={() => retrySpeech(message.content)} title="Play using browser speech"><Volume2 size={14} />{elapsedSpeech ? 'Playing' : 'Listen'}</button></div>}</div></div>)}
            {busy && <div className="message-row message-assistant"><span className="message-avatar assistant-avatar"><ShieldCheck size={16} /></span><div className="message-body"><div className="message-meta"><strong>Guardian assistant</strong></div><div className="message-bubble thinking"><LoaderCircle size={15} className="spin" /> Reviewing caller message…</div></div></div>}
            <div ref={messageEnd} />
          </div>
          <div className="composer-wrap"><form className="message-composer" onSubmit={sendMessage}><textarea ref={inputRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} maxLength={2000} rows={2} disabled={busy} placeholder="Type what the caller says…" aria-label="Caller message" /><div className="composer-bottom"><span>{draft.length}/2,000 · Enter to send</span><button className="button button-primary button-sm" type="submit" disabled={busy || !draft.trim()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}Send</button></div></form></div>
          {ending && <div className="outcome-confirm"><div className="outcome-confirm-heading"><div><strong>Save the simulation outcome</strong><small>Choose what happened in this simulated call.</small></div><button className="icon-button" onClick={() => setEnding(false)} aria-label="Keep simulation active"><X size={17} /></button></div><div className="outcome-buttons">{(['AI handled', 'Transferred', 'Declined'] as Outcome[]).map((outcome) => <button className="button button-secondary button-sm" key={outcome} onClick={() => void endCall(outcome)} disabled={ending}>{ending ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{outcome}</button>)}</div></div>}
          {!ending && <div className="session-footer"><span><MicOff size={15} /> No microphone is active</span><button className="text-link danger-link" onClick={() => setEnding(true)}><CircleStop size={15} /> End & save call</button></div>}
        </>}
      </section>
      <aside className="panel assistant-side-panel"><span className="eyebrow">SESSION NOTES</span><h3>What this assistant can do</h3><ul className="capability-list"><li><span className="capability-icon"><ShieldCheck size={16} /></span><span><strong>Review text</strong><small>Classify the caller’s message and suggest a response.</small></span></li><li><span className="capability-icon"><AlertTriangle size={16} /></span><span><strong>Flag risk</strong><small>Highlight requests for credentials or likely scam patterns.</small></span></li><li><span className="capability-icon"><Volume2 size={16} /></span><span><strong>Read aloud</strong><small>Optional playback uses the browser’s installed voice.</small></span></li></ul><div className="capability-boundary"><ShieldCheck size={16} /><p>There is no live audio, call recording, transcription, or carrier integration in this version.</p></div><div className="assistant-config-line"><span>Model</span><strong>Managed by backend configuration</strong></div>{apiStatus === 'missing' && <div className="setup-notice"><AlertTriangle size={15} /> Set GEMINI_API_KEY on the backend to enable AI responses.</div>}{apiStatus === 'configured' && <div className="setup-notice"><RotateCcw size={14} /> The key is present; provider access is confirmed only after a successful response.</div>}
      </aside>
    </div>
  </div>;
}
