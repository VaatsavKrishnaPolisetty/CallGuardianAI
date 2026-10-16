"""CallGuardianAI Voice Pipeline & WebRTC Transport

Powered by Pipecat AI & Silero VAD.
Handles:
1. Microsecond Voice Activity Detection (VAD) with Silero.
2. Interruption & Barge-In detection (cuts off AI speech immediately when caller speaks).
3. Daily.co WebRTC room provisioning and token management.
4. Seamless fallback to local WebSocket audio streaming when running without cloud credentials.
"""

import os
import time
import logging
from typing import Optional, Dict, Any, Callable
import httpx

logger = logging.getLogger("callguardian.voice")

# Silero VAD availability check
try:
    from pipecat.audio.vad.silero import SileroVADAnalyzer
    from pipecat.audio.vad.vad_analyzer import VADParams
    PIPECAT_AVAILABLE = True
except Exception as _err:
    logger.warning("Pipecat Silero VAD not loaded; using fallback VAD: %s", _err)
    PIPECAT_AVAILABLE = False


class VADTurnManager:
    """Manages turn-taking, speech boundaries, and caller interruptions."""

    def __init__(
        self,
        stop_secs: float = 0.6,
        start_secs: float = 0.15,
        confidence: float = 0.65,
        on_barge_in: Optional[Callable[[], Any]] = None,
    ):
        self.stop_secs = stop_secs
        self.start_secs = start_secs
        self.confidence = confidence
        self.on_barge_in = on_barge_in
        self.is_speaking = False
        self.ai_is_speaking = False
        self.last_speech_time = 0.0
        self.vad_analyzer = None

        if PIPECAT_AVAILABLE:
            try:
                self.vad_analyzer = SileroVADAnalyzer(
                    params=VADParams(
                        confidence=self.confidence,
                        start_secs=self.start_secs,
                        stop_secs=self.stop_secs,
                    )
                )
            except Exception as e:
                logger.warning("Could not initialize SileroVADAnalyzer: %s", e)

    def set_ai_speaking(self, speaking: bool) -> None:
        """Track whether the AI receptionist is currently speaking to detect barge-in."""
        self.ai_is_speaking = speaking

    def handle_caller_speech_start(self) -> Dict[str, Any]:
        """Called when caller audio triggers voice detection."""
        self.is_speaking = True
        self.last_speech_time = time.time()
        was_interrupted = False

        # If caller starts speaking while AI is talking, trigger Barge-In!
        if self.ai_is_speaking:
            was_interrupted = True
            self.ai_is_speaking = False
            logger.info("Caller barge-in detected! Muting AI speech stream immediately.")
            if self.on_barge_in:
                try:
                    self.on_barge_in()
                except Exception as ex:
                    logger.warning("Barge-in callback error: %s", ex)

        return {
            "event": "speech_started",
            "barge_in": was_interrupted,
            "timestamp": self.last_speech_time,
        }

    def handle_caller_speech_stop(self) -> Dict[str, Any]:
        """Called when caller pauses speaking and turn should be evaluated."""
        self.is_speaking = False
        now = time.time()
        duration = now - self.last_speech_time if self.last_speech_time > 0 else 0
        return {
            "event": "speech_stopped",
            "duration_seconds": round(duration, 2),
            "timestamp": now,
        }


# ── Daily.co WebRTC Room Management ─────────────────────────────────────────

async def create_daily_room(room_name: Optional[str] = None, exp_minutes: int = 60) -> Dict[str, Any]:
    """Create a temporary, secure Daily.co WebRTC room for live call screening.
    
    If DAILY_API_KEY is not set, returns a local-mode configuration so the UI
    operates over browser WebRTC/WebAudio without throwing errors.
    """
    daily_key = (os.getenv("DAILY_API_KEY") or "").strip()
    if not daily_key:
        return {
            "enabled": False,
            "mode": "browser_local",
            "reason": "DAILY_API_KEY not configured. Using browser microphone & local audio buffer.",
            "url": None,
            "token": None,
        }

    url = "https://api.daily.co/v1/rooms"
    headers = {
        "Authorization": f"Bearer {daily_key}",
        "Content-Type": "application/json",
    }
    exp_ts = int(time.time()) + (exp_minutes * 60)
    data = {
        "properties": {
            "exp": exp_ts,
            "enable_chat": False,
            "enable_knocking": False,
            "eject_at_room_exp": True,
            "start_audio_off": False,
            "start_video_off": True,
        }
    }
    if room_name:
        data["name"] = room_name[:40].lower().replace(" ", "-")

    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            res = await client.post(url, json=data, headers=headers)
            if res.status_code in (200, 201):
                room_data = res.json()
                room_url = room_data.get("url")
                # Generate participant token
                token_res = await client.post(
                    "https://api.daily.co/v1/meeting-tokens",
                    json={"properties": {"room_name": room_data.get("name"), "exp": exp_ts, "is_owner": True}},
                    headers=headers,
                )
                token = token_res.json().get("token") if token_res.status_code == 200 else None
                return {
                    "enabled": True,
                    "mode": "daily_webrtc",
                    "url": room_url,
                    "token": token,
                    "expires_at": exp_ts,
                }
            logger.warning("Daily API room creation failed (HTTP %d): %s", res.status_code, res.text[:200])
            return {
                "enabled": False,
                "mode": "browser_local",
                "reason": f"Daily API returned HTTP {res.status_code}",
                "url": None,
                "token": None,
            }
        except Exception as exc:
            logger.warning("Daily API request exception: %s", exc)
            return {
                "enabled": False,
                "mode": "browser_local",
                "reason": str(exc),
                "url": None,
                "token": None,
            }
