import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useReducedMotion } from 'framer-motion';
import {
  EmptyState,
  PageHeading,
  StatusBadge,
} from '../components/WorkspaceUI';
import { Mic, PhoneOff, Phone, Search, Send, CheckCircle2, Globe } from 'lucide-react';
import { io as socketIO } from 'socket.io-client';
import { useWorkspaceAuth } from '../components/WorkspaceAuth';
import NudgeFeed from '../components/NudgeFeed';
import LivePlaybook from '../components/LivePlaybook';
import LiveDisclosureChecklist from '../components/LiveDisclosureChecklist';
import { DEFAULT_GUIDED_MODE } from '../voice-session-mode.js';

// ─── Market Profiles ──────────────────────────────────────────
const MARKETS = {
  'india-loan': { name: 'India Loans', agent: 'Aria', lang: 'en-IN' },
  'india-insurance': { name: 'India Insurance', agent: 'Priya', lang: 'en-IN' },
  'ph-bancassurance': { name: 'Philippines', agent: 'Maria', lang: 'en-PH' },
  'id-finance': {
    name: 'Indonesia',
    agent: 'Dewi',
    lang: 'id',
    color: '#10B981',
  },
};

function VoiceWave({ level, active }) {
  const reduced = useReducedMotion();
  return (
    <div className="voice-wave" aria-hidden="true">
      {Array.from({ length: 29 }, (_, i) => (
        <i
          key={i}
          style={{
            transform: `scaleY(${active && !reduced ? 0.2 + Math.min(1, level) * (1 + Math.sin(i * 0.9)) * 1.5 : 0.12 + Math.abs(Math.sin(i * 0.8)) * 0.25})`,
          }}
        />
      ))}
    </div>
  );
}
function MessageBubble({ msg, turnIndex }) {
  const isUser = msg.role === 'user';
  const elapsedLabel = Number.isFinite(msg.elapsed_ms) && msg.elapsed_ms >= 0
    ? `+${Math.floor(msg.elapsed_ms / 60_000)}:${String(Math.floor(msg.elapsed_ms / 1_000) % 60).padStart(2, '0')}`
    : null;
  return (
    <article
      id={Number.isInteger(turnIndex) ? `live-turn-${turnIndex}` : undefined}
      tabIndex={Number.isInteger(turnIndex) ? -1 : undefined}
      className={`message ${isUser ? 'message-customer' : ''} focus:outline-2 focus:outline-offset-4 focus:outline-[var(--accent)]`}
    >
      <div className="message-meta">
        <span className="font-semibold">
          {isUser ? 'Customer' : msg.agentName || 'Veyra agent'}
        </span>
        {msg.ts && (
          <time>
            {new Date(msg.ts).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
        )}
        {elapsedLabel && <span>{elapsedLabel}</span>}
        {msg.isPartial && <span>Transcribing…</span>}
      </div>
      <p className="message-content">{msg.content}</p>
      {!isUser &&
        msg.sources?.map((source, index) => (
          <details
            key={source.chunk_id || index}
            id={Number.isInteger(turnIndex) ? `live-source-${turnIndex}-${index}` : undefined}
            className="source-detail"
          >
            <summary tabIndex={-1}>
              Source {index + 1} ·{' '}
              {source.title || source.source || 'Knowledge document'}
            </summary>
            <div className="mt-3 space-y-2 text-muted">
              {source.revision && <p>Revision {source.revision}</p>}
              {source.page && <p>PDF page {source.page}</p>}
              {source.document_id && (
                <p className="break-all text-[10px]">{source.document_id}</p>
              )}
              {(source.excerpt || source.content) && (
                <p className="whitespace-pre-wrap">
                  {source.excerpt || source.content}
                </p>
              )}
              {source.chunk_id && (
                <p className="font-mono text-[10px] break-all">
                  {source.chunk_id}
                </p>
              )}
            </div>
          </details>
        ))}
    </article>
  );
}

// ─── Main Page ────────────────────────────────────────────────
export default function VoiceStudioPage() {
  const { user } = useWorkspaceAuth();
  const activeCallKey = `veyra.activeCall.${user.id}`;
  const [market, setMarket] = useState('india-loan');
  const [callState, setCallState] = useState('idle'); // idle | connecting | active | ending
  const [isSpeaking, setIsSpeaking] = useState(false); // agent speaking
  const [volumeLevel, setVolumeLevel] = useState(0);
  const [messages, setMessages] = useState([]);
  const [partialTranscript, setPartialTranscript] = useState('');
  const [activeStage, setActiveStage] = useState(null);
  const [latencies, setLatencies] = useState({});
  const [totalCallLatency, setTotalCallLatency] = useState(null);
  const [error, setError] = useState(null);
  const [rawError, setRawError] = useState(null);
  const [inputText, setInputText] = useState('');
  const [isTextProcessing, setIsTextProcessing] = useState(false);
  const [micStatus, setMicStatus] = useState('unknown');
  const [useTextMode, setUseTextMode] = useState(false);
  const [isListening, setIsListening] = useState(false); // mic capturing
  // Voice Studio is an autonomous agent by default. Human review remains an
  // explicit opt-in for regulated or supervised conversations; enabling it
  // intentionally pauses each grounded answer until an operator approves it.
  const [guidedMode, setGuidedMode] = useState(DEFAULT_GUIDED_MODE);
  const [guidanceQuestion, setGuidanceQuestion] = useState('');
  const [guidanceBusy, setGuidanceBusy] = useState(false);
  const [guidanceMessage, setGuidanceMessage] = useState('');
  const [guidanceError, setGuidanceError] = useState('');

  const recognitionRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const animFrameRef = useRef(null);
  const micStreamRef = useRef(null);
  const isProcessingRef = useRef(false);
  const callStateRef = useRef('idle'); // mirror of callState for event handlers
  const isSpeakingRef = useRef(false); // mirror of isSpeaking
  const requestAbortRef = useRef(null);
  const speechGenerationRef = useRef(0);
  const stageTimerRef = useRef(null);
  const sessionIdRef = useRef(null);
  const [hasSession, setHasSession] = useState(false);
  const [restoringSession, setRestoringSession] = useState(true);
  const socketRef = useRef(null);
  const chatEndRef = useRef(null);

  const current = MARKETS[market];

  const navigateToChecklistEvidence = useCallback((turnIndex, sourceIndex) => {
    const source = Number.isInteger(sourceIndex)
      ? document.getElementById(`live-source-${turnIndex}-${sourceIndex}`)
      : null;
    if (source) source.open = true;
    const target = source || document.getElementById(`live-turn-${turnIndex}`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    (source?.querySelector('summary') || target).focus({ preventScroll: true });
  }, []);

  // Every browser turn uses the same server-owned call id. This keeps RAG
  // history, socket updates, nudges, and escalation summaries tied together.
  const ensureSession = useCallback(async () => {
    if (sessionIdRef.current) return sessionIdRef.current;
    const response = await fetch('/api/voice/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        market,
        language: MARKETS[market]?.lang || 'en-IN',
        channel: useTextMode ? 'text' : 'voice',
      }),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new Error(
        detail?.message || detail?.error || 'Unable to create a voice session'
      );
    }
    const data = await response.json();
    sessionIdRef.current = data.call_id;
    sessionStorage.setItem(activeCallKey, data.call_id);
    setHasSession(true);
    socketRef.current?.emit('monitor:call', { call_id: data.call_id });
    return data.call_id;
  }, [activeCallKey, market, useTextMode]);

  // ── Scroll to bottom on new messages ──
  useEffect(() => {
    const container = chatEndRef.current?.parentElement;
    if (container) container.scrollTop = container.scrollHeight;
  }, [messages, partialTranscript]);

  // ── Socket.IO for server-side pipeline events ──
  useEffect(() => {
    // Connect through the current origin so Vite's /socket.io proxy and deployed
    // same-origin installations both work. The old hard-coded :3001 target broke
    // whenever PORT was configured differently.
    const socket = socketIO({ path: '/socket.io', transports: ['websocket'] });
    socketRef.current = socket;
    socket.on('pipeline:latency', (data) => {
      setLatencies((prev) => ({
        ...prev,
        rag: data.rag_ms,
        gateway: data.total_ms - data.rag_ms,
      }));
      setTotalCallLatency(data.total_ms);
    });
    return () => socket.disconnect();
  }, []);

  // Keep a text conversation reachable after changing pages or reloading.
  // The server snapshot is authoritative, so completed calls are never resumed.
  useEffect(() => {
    let mounted = true;
    const callId = sessionStorage.getItem(activeCallKey);
    if (!callId) {
      setRestoringSession(false);
      return;
    }
    (async () => {
      try {
        const response = await fetch(`/api/voice/session/${encodeURIComponent(callId)}`);
        if (!response.ok) throw new Error('Session is unavailable');
        const session = await response.json();
        if (!['created', 'active', 'escalated'].includes(session.status) || !MARKETS[session.market]) {
          throw new Error('Session has ended');
        }
        if (!mounted) return;
        sessionIdRef.current = callId;
        setMarket(session.market);
        setUseTextMode(session.channel !== 'voice');
        setMessages((session.turns || []).map((turn, index) => ({
          ...turn,
          id: `${callId}-${index}`,
          agentName: `${MARKETS[session.market].agent} (Veyra)`,
          ts: turn.ts || session.created_at,
        })));
        setTotalCallLatency([...(session.turns || [])].reverse().find((turn) => turn.role === 'assistant')?.latency_ms || null);
        setHasSession(true);
        socketRef.current?.emit('monitor:call', { call_id: callId });
      } catch (_) {
        if (mounted) sessionStorage.removeItem(activeCallKey);
      } finally {
        if (mounted) setRestoringSession(false);
      }
    })();
    return () => { mounted = false; };
  }, [activeCallKey]);

  // ── Web Speech API: initialize SpeechRecognition with Silence Debouncing ──
  const silenceTimerRef = useRef(null);
  const accumulatedSpeechRef = useRef('');

  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setError(
        'Voice input requires Chrome or Edge browser. Use Text Mode on other browsers.'
      );
      setUseTextMode(true);
      return;
    }

    const recognition = new SR();
    recognition.continuous = true; // Listen continuously without stopping at short pauses
    recognition.interimResults = true;
    recognition.lang = MARKETS[market]?.lang || 'en-IN';
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      setIsListening(true);
      if (!isSpeakingRef.current && !isProcessingRef.current) {
        setActiveStage('asr');
      }
    };

    recognition.onresult = (event) => {
      // Ignore incoming speech audio while agent is speaking or processing RAG query
      if (isSpeakingRef.current || isProcessingRef.current) return;

      let fullTranscript = '';
      for (let i = 0; i < event.results.length; i++) {
        fullTranscript += event.results[i][0].transcript + ' ';
      }
      fullTranscript = fullTranscript.trim();

      if (!fullTranscript) return;

      // Append to accumulated speech for this turn
      if (
        !accumulatedSpeechRef.current ||
        fullTranscript.length > accumulatedSpeechRef.current.length
      ) {
        accumulatedSpeechRef.current = fullTranscript;
      }

      setPartialTranscript(accumulatedSpeechRef.current);

      // Reset silence debounce timer: submit query 1400ms after user finishes sentence
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);

      silenceTimerRef.current = setTimeout(() => {
        const finalQuery = accumulatedSpeechRef.current.trim();
        if (
          finalQuery &&
          finalQuery.length > 2 &&
          !isProcessingRef.current &&
          !isSpeakingRef.current
        ) {
          isProcessingRef.current = true;
          setPartialTranscript('');
          processVoiceQuery(finalQuery);
        }
      }, 1400);
    };

    recognition.onend = () => {
      setIsListening(false);
      // Auto-restart recognition if call is active and agent is done speaking
      if (
        callStateRef.current === 'active' &&
        !isProcessingRef.current &&
        !isSpeakingRef.current
      ) {
        setTimeout(() => {
          try {
            recognition.start();
          } catch (_) {}
        }, 300);
      }
    };

    recognition.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      console.warn('SpeechRecognition notice:', event.error);
      if (event.error === 'not-allowed' || event.error === 'network') {
        setError(event.error === 'not-allowed'
          ? 'Microphone access was denied. Continue this session in Text Mode, or allow microphone access and try again.'
          : 'Voice recognition is unavailable. Continue this session in Text Mode.');
        // Recognition cannot produce a transcript after either error. Release
        // the microphone and leave the server session available for text input.
        callStateRef.current = 'idle';
        setCallState('idle');
        setUseTextMode(true);
        setIsListening(false);
        setActiveStage(null);
        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
        try { recognition.abort(); } catch (_) {}
        cancelAnimationFrame(animFrameRef.current);
        micStreamRef.current?.getTracks().forEach((track) => track.stop());
        audioCtxRef.current?.close();
        micStreamRef.current = null;
        audioCtxRef.current = null;
        analyserRef.current = null;
        setVolumeLevel(0);
      }
    };

    recognitionRef.current = recognition;
    return () => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      try {
        recognition.abort();
      } catch (_) {}
      if (recognitionRef.current === recognition) recognitionRef.current = null;
    };
  }, [market]);

  // ── Mic AudioContext: real volume visualization ──
  const startMicVisualization = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      micStreamRef.current = stream;
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;

      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        setVolumeLevel(Math.min(avg / 80, 1));
        animFrameRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (_) {
      // Visualization optional — silently skip if blocked
    }
  }, []);

  const stopMicVisualization = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current);
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    audioCtxRef.current?.close();
    audioCtxRef.current = null;
    analyserRef.current = null;
    micStreamRef.current = null;
    setVolumeLevel(0);
  }, []);

  useEffect(
    () => () => {
      callStateRef.current = 'idle';
      requestAbortRef.current?.abort();
      speechGenerationRef.current += 1;
      window.speechSynthesis?.cancel();
      stopMicVisualization();
    },
    [stopMicVisualization]
  );

  // ── Core: send query to RAG, stream TTS back ──
  const processVoiceQuery = useCallback(
    async (query) => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      // Do not let the recognizer hear the browser's own TTS response. It will be
      // restarted once this turn has finished.
      try {
        recognitionRef.current?.stop();
      } catch (_) {}
      setMessages((prev) => [
        ...prev,
        {
          id: `usr-${Date.now()}`,
          role: 'user',
          content: query,
          ts: new Date().toISOString(),
        },
      ]);
      setActiveStage('gateway');
      if (stageTimerRef.current) clearTimeout(stageTimerRef.current);
      stageTimerRef.current = setTimeout(() => setActiveStage('rag'), 100);

      const controller = new AbortController();
      requestAbortRef.current?.abort();
      requestAbortRef.current = controller;

      try {
        const t0 = Date.now();
        const callId = await ensureSession();
        const res = await fetch('/api/voice/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query,
            top_k: 2,
            call_id: callId,
            market,
            language: MARKETS[market]?.lang || 'en-IN',
            guided_mode: guidedMode,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const detail = await res.json().catch(() => null);
          throw new Error(
            detail?.message || detail?.error || `RAG HTTP ${res.status}`
          );
        }
        const data = await res.json();
        const ragMs = Date.now() - t0;

        setActiveStage('llm');
        setTotalCallLatency(data.latency_ms || ragMs);
        setLatencies((prev) => ({
          ...prev,
          rag: data.retrieval_latency_ms,
          llm: data.llm_latency_ms,
          gateway: ragMs - (data.latency_ms || 0),
        }));

        if (data.response_kind === 'guided_suggestion') {
          setActiveStage(null);
          isProcessingRef.current = false;
          accumulatedSpeechRef.current = '';
          if (callStateRef.current === 'active') {
            setTimeout(() => {
              try {
                recognitionRef.current?.start();
              } catch (_) {}
            }, 200);
          }
          return;
        }

        const answer =
          data.answer ||
          'I could not find that information in the knowledge base.';
        setMessages((prev) => [
          ...prev,
          {
            id: `agt-${Date.now()}`,
            role: 'assistant',
            content: answer,
            sources: data.sources || [],
            latency_ms: data.latency_ms || ragMs,
            agentName: `${MARKETS[market]?.agent || 'Veyra'} (Veyra)`,
            ts: new Date().toISOString(),
          },
        ]);

        // ── TTS: speak the answer ──
        setActiveStage('tts');
        setIsSpeaking(true);
        isSpeakingRef.current = true;
        if (
          !window.speechSynthesis ||
          typeof window.SpeechSynthesisUtterance === 'undefined'
        ) {
          throw new Error(
            'Text-to-speech is not available in this browser. Use Chrome or Edge.'
          );
        }
        speechGenerationRef.current += 1;
        window.speechSynthesis.cancel(); // clear any queued speech
        const speechGeneration = speechGenerationRef.current;

        const cleanAnswerForSpeech = answer
          .replace(/\|/g, ', ')
          .replace(/[\*\#\`\_]/g, '')
          .replace(/\bINR\b/g, 'Rupees')
          .replace(/\s+/g, ' ')
          .trim();

        const utterance = new window.SpeechSynthesisUtterance(
          cleanAnswerForSpeech
        );
        utterance.lang = MARKETS[market]?.lang || 'en-IN';
        utterance.rate = 1.05;
        utterance.pitch = 1.0;
        // Pick a clear female voice if available
        const voices = window.speechSynthesis.getVoices();
        const languagePrefix = utterance.lang.split('-')[0].toLowerCase();
        const preferred =
          voices.find(
            (v) =>
              v.lang.toLowerCase().startsWith(languagePrefix) &&
              v.name.toLowerCase().includes('female')
          ) ||
          voices.find(
            (v) =>
              v.lang.toLowerCase().startsWith(languagePrefix) &&
              !v.name.toLowerCase().includes('male')
          ) ||
          voices[0];
        if (preferred) utterance.voice = preferred;

        utterance.onend = () => {
          if (speechGeneration !== speechGenerationRef.current) return;
          setIsSpeaking(false);
          isSpeakingRef.current = false;
          setActiveStage(null);
          isProcessingRef.current = false;
          accumulatedSpeechRef.current = '';
          if (callStateRef.current === 'active') {
            setTimeout(() => {
              try {
                recognitionRef.current?.start();
              } catch (_) {}
            }, 200);
          }
        };
        utterance.onerror = (e) => {
          if (speechGeneration !== speechGenerationRef.current) return;
          console.warn('TTS error:', e);
          setIsSpeaking(false);
          isSpeakingRef.current = false;
          setActiveStage(null);
          isProcessingRef.current = false;
          accumulatedSpeechRef.current = '';
          if (callStateRef.current === 'active') {
            setTimeout(() => {
              try {
                recognitionRef.current?.start();
              } catch (_) {}
            }, 200);
          }
        };

        window.speechSynthesis.speak(utterance);
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.error('RAG query error:', err);
        setMessages((prev) => [
          ...prev,
          {
            id: `err-${Date.now()}`,
            role: 'assistant',
            content: `Sorry, I encountered an error: ${err.message}`,
            sources: [],
            ts: new Date().toISOString(),
          },
        ]);
        setActiveStage(null);
        setIsSpeaking(false);
        isSpeakingRef.current = false;
        isProcessingRef.current = false;
        // Resume listening even on error
        if (callStateRef.current === 'active') {
          setTimeout(() => {
            try {
              recognitionRef.current?.start();
            } catch (_) {}
          }, 800);
        }
      } finally {
        if (requestAbortRef.current === controller)
          requestAbortRef.current = null;
      }
    },
    [ensureSession, guidedMode, market]
  );

  // ── Start Voice Call ──
  const startCall = useCallback(async () => {
    setError(null);
    setRawError(null);
    setCallState('connecting');
    callStateRef.current = 'connecting';
    if (!sessionIdRef.current) setMessages([]);
    setLatencies({});
    accumulatedSpeechRef.current = '';
    setPartialTranscript('');
    isProcessingRef.current = false;
    isSpeakingRef.current = false;

    if (!recognitionRef.current) {
      setError(
        'Voice input requires Chrome or Edge. Switch to Text Mode to continue.'
      );
      setUseTextMode(true);
      setCallState('idle');
      callStateRef.current = 'idle';
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setError(
        'Microphone access requires a secure browser context (HTTPS or localhost). Use Text Mode to continue.'
      );
      setUseTextMode(true);
      setCallState('idle');
      callStateRef.current = 'idle';
      return;
    }

    // Pre-check mic
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setMicStatus('granted');
    } catch (micErr) {
      setMicStatus('denied');
      setError(
        `Microphone blocked: ${micErr.message}. Click the lock icon → allow microphone → try again.`
      );
      setCallState('idle');
      callStateRef.current = 'idle';
      return;
    }

    try {
      await ensureSession();
    } catch (sessionError) {
      setError(`Voice service is unavailable: ${sessionError.message}`);
      setCallState('idle');
      callStateRef.current = 'idle';
      return;
    }

    setCallState('active');
    callStateRef.current = 'active';
    await startMicVisualization();
    try {
      recognitionRef.current?.start();
    } catch (_) {}
  }, [ensureSession, startMicVisualization]);

  // ── End Voice Call ──
  const endCall = useCallback(async () => {
    callStateRef.current = 'ending';
    setCallState('ending');
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    if (stageTimerRef.current) clearTimeout(stageTimerRef.current);
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    try {
      recognitionRef.current?.abort();
    } catch (_) {}
    speechGenerationRef.current += 1;
    window.speechSynthesis?.cancel();
    stopMicVisualization();
    isProcessingRef.current = false;
    isSpeakingRef.current = false;
    setActiveStage(null);
    setIsSpeaking(false);
    setIsListening(false);
    setPartialTranscript('');
    try {
      if (sessionIdRef.current) {
        const response = await fetch(
          `/api/voice/session/${encodeURIComponent(sessionIdRef.current)}/end`,
          { method: 'POST' }
        );
        if (!response.ok)
          throw new Error(
            'Unable to save this call. Please try ending it again.'
          );
        sessionIdRef.current = null;
        sessionStorage.removeItem(activeCallKey);
        setHasSession(false);
        setGuidanceQuestion('');
        setGuidanceMessage('');
        setGuidanceError('');
      }
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      callStateRef.current = 'idle';
      setCallState('idle');
    }
  }, [activeCallKey, stopMicVisualization]);

  // ── Text-mode query (fallback) ──
  const handleTextQuery = useCallback(
    async (text) => {
      const query = text || inputText;
      if (
        !query.trim() ||
        isTextProcessing ||
        callStateRef.current === 'ending'
      )
        return;
      setInputText('');
      setIsTextProcessing(true);
      setMessages((prev) => [
        ...prev,
        {
          id: `usr-${Date.now()}`,
          role: 'user',
          content: query,
          ts: new Date().toISOString(),
        },
      ]);

      setActiveStage('gateway');
      setTimeout(() => setActiveStage('rag'), 80);

      try {
        const callId = await ensureSession();
        const res = await fetch('/api/voice/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query,
            top_k: 2,
            call_id: callId,
            market,
            language: MARKETS[market]?.lang || 'en-IN',
            guided_mode: guidedMode,
          }),
        });
        if (!res.ok) {
          const detail = await res.json().catch(() => null);
          throw new Error(
            detail?.message || detail?.error || `HTTP ${res.status}`
          );
        }
        const data = await res.json();
        setActiveStage('llm');
        setTotalCallLatency(data.latency_ms);
        if (data.response_kind === 'guided_suggestion') {
          setActiveStage(null);
          return;
        }
        setMessages((prev) => [
          ...prev,
          {
            id: `agt-${Date.now()}`,
            role: 'assistant',
            content: data.answer,
            sources: data.sources || [],
            latency_ms: data.latency_ms,
            agentName: `${MARKETS[market]?.agent || 'Veyra'} (Veyra)`,
            ts: new Date().toISOString(),
          },
        ]);
        setActiveStage(null);
      } catch (err) {
        console.error('RAG query error:', err);
        setMessages((prev) => [
          ...prev,
          {
            id: `err-${Date.now()}`,
            role: 'assistant',
            content:
              'The answer could not be retrieved. Please try again or ask a human for help.',
            sources: [],
            ts: new Date().toISOString(),
          },
        ]);
        setActiveStage(null);
      } finally {
        setIsTextProcessing(false);
      }
    },
    [ensureSession, guidedMode, inputText, isTextProcessing, market]
  );

  const requestPrivateGuidance = useCallback(async (event) => {
    event.preventDefault();
    const query = guidanceQuestion.trim();
    const callId = sessionIdRef.current;
    if (!query || !callId || guidanceBusy) return;
    setGuidanceBusy(true);
    setGuidanceError('');
    setGuidanceMessage('');
    try {
      const response = await fetch(
        `/api/voice/session/${encodeURIComponent(callId)}/guidance/query`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query }),
        }
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Private guidance is unavailable.');
      if (!data.suggestion) {
        setGuidanceMessage(data.message || 'No approved knowledge supports that question.');
        return;
      }
      setGuidanceQuestion('');
      setGuidanceMessage('A private grounded reply is ready below.');
    } catch (requestError) {
      setGuidanceError(requestError.message);
    } finally {
      setGuidanceBusy(false);
    }
  }, [guidanceBusy, guidanceQuestion]);

  const preparePrivateGuidance = useCallback((question) => {
    setGuidanceQuestion(question);
    setGuidanceMessage('Playbook question prepared. Review it, then search approved knowledge.');
    setGuidanceError('');
  }, []);

  const applyGuidedNudge = useCallback(
    async (nudge, responseText) => {
      const callId = sessionIdRef.current;
      if (!callId) throw new Error('Start a session before using a guided reply.');
      if (isProcessingRef.current && !isSpeakingRef.current) {
        throw new Error('Wait for the current customer turn to finish processing.');
      }
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      try {
        recognitionRef.current?.stop();
      } catch (_) {}
      speechGenerationRef.current += 1;
      window.speechSynthesis?.cancel();
      isProcessingRef.current = true;
      isSpeakingRef.current = false;
      setIsSpeaking(false);
      setIsTextProcessing(true);
      setActiveStage('gateway');
      try {
        const response = await fetch(
          `/api/voice/session/${encodeURIComponent(callId)}/nudges/${encodeURIComponent(nudge.id)}/apply`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ response_text: responseText }),
          }
        );
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not apply this guided reply.');
        setMessages((previous) => previous.some((message) => message.guided_by_nudge_id === nudge.id)
          ? previous
          : [...previous, {
              ...data.turn,
              id: `guided-${nudge.id}`,
              agentName: `${MARKETS[market]?.agent || 'Veyra'} (guided)`,
            }]);
        setActiveStage(null);

        if (useTextMode || !window.speechSynthesis || typeof window.SpeechSynthesisUtterance === 'undefined') {
          isProcessingRef.current = false;
          if (!useTextMode) setError('The guided reply was added to the conversation, but text-to-speech is unavailable in this browser.');
          return;
        }

        const cleanAnswer = data.answer
          .replace(/\|/g, ', ')
          .replace(/[\*\#\`\_]/g, '')
          .replace(/\bINR\b/g, 'Rupees')
          .replace(/\s+/g, ' ')
          .trim();
        const utterance = new window.SpeechSynthesisUtterance(cleanAnswer);
        const speechGeneration = speechGenerationRef.current;
        utterance.lang = MARKETS[market]?.lang || 'en-IN';
        utterance.rate = 1.05;
        const voices = window.speechSynthesis.getVoices();
        const languagePrefix = utterance.lang.split('-')[0].toLowerCase();
        utterance.voice = voices.find((voice) =>
          voice.lang.toLowerCase().startsWith(languagePrefix) &&
          voice.name.toLowerCase().includes('female')) ||
          voices.find((voice) => voice.lang.toLowerCase().startsWith(languagePrefix)) || voices[0];
        const finish = () => {
          if (speechGeneration !== speechGenerationRef.current) return;
          setIsSpeaking(false);
          isSpeakingRef.current = false;
          isProcessingRef.current = false;
          if (callStateRef.current === 'active') {
            setTimeout(() => {
              try {
                recognitionRef.current?.start();
              } catch (_) {}
            }, 200);
          }
        };
        utterance.onend = finish;
        utterance.onerror = finish;
        setIsSpeaking(true);
        isSpeakingRef.current = true;
        setActiveStage('tts');
        window.speechSynthesis.speak(utterance);
      } catch (error) {
        isProcessingRef.current = false;
        setActiveStage(null);
        if (callStateRef.current === 'active') {
          setTimeout(() => {
            try {
              recognitionRef.current?.start();
            } catch (_) {}
          }, 300);
        }
        throw error;
      } finally {
        setIsTextProcessing(false);
      }
    },
    [market, useTextMode]
  );

  const isCallActive = callState === 'active';
  const isConnecting = restoringSession || callState === 'connecting' || callState === 'ending';

  return (
    <div className="page">
      <PageHeading
        eyebrow="Conversation workspace"
        title="Voice Studio"
        description="Talk to your knowledge. Follow every answer back to its source."
        actions={
          <StatusBadge
            tone={
              isCallActive ? 'success' : isConnecting ? 'warning' : 'neutral'
            }
          >
            {restoringSession
              ? 'Restoring session'
              : isCallActive
              ? 'Call active'
              : isConnecting
                ? callState === 'ending'
                  ? 'Saving session'
                  : 'Connecting'
                : hasSession
                  ? 'Session open'
                  : 'Ready when you are'}
          </StatusBadge>
        }
      />
      {error && (
        <div
          role="alert"
          className="notice notice-error flex flex-wrap items-center justify-between gap-3"
        >
          <span className="flex-1">{error}</span>
          <button
            className="btn"
            disabled={isCallActive || isConnecting}
            onClick={() => setUseTextMode(true)}
          >
            Use Text Mode
          </button>
          {rawError && (
            <details className="basis-full">
              <summary>Technical details</summary>
              <pre className="text-xs whitespace-pre-wrap break-all mt-3">
                {JSON.stringify(rawError, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
      <div className="voice-layout">
        <aside
          className="panel !p-5"
          aria-label="Agent selection and session controls"
        >
          <div className="panel-header !mb-4">
            <div>
              <h2 className="panel-title">Choose your agent</h2>
              <p className="panel-description">Four markets. One workspace.</p>
            </div>
            <Globe size={17} className="text-muted" />
          </div>
          <label className="agent-mobile-selector text-xs text-muted">
            Agent and market
            <select
              className="field mt-2"
              value={market}
              disabled={hasSession || isConnecting || isTextProcessing}
              onChange={(event) => {
                setMarket(event.target.value);
                setMessages([]);
                setTotalCallLatency(null);
                setLatencies({});
              }}
            >
              {Object.entries(MARKETS).map(([key, agent]) => (
                <option key={key} value={key}>
                  {agent.agent} · {agent.name}
                </option>
              ))}
            </select>
          </label>
          <div className="agent-options space-y-1">
            {Object.entries(MARKETS).map(([key, agent]) => (
              <button
                key={key}
                className={`agent-option ${market === key ? 'selected' : ''}`}
                aria-pressed={market === key}
                disabled={hasSession || isConnecting || isTextProcessing}
                onClick={() => {
                  setMarket(key);
                  setMessages([]);
                  setTotalCallLatency(null);
                  setLatencies({});
                }}
              >
                <span className="agent-initial">{agent.agent.slice(0, 1)}</span>
                <span className="flex-1">
                  <strong className="block text-xs font-semibold">
                    {agent.agent}
                  </strong>
                  <span className="block text-[10px] text-muted mt-1">
                    {agent.name}
                  </span>
                </span>
                {market === key && (
                  <CheckCircle2 size={15} className="text-accent" />
                )}
              </button>
            ))}
          </div>
          <div className="voice-session">
            <p className="text-[10px] text-muted uppercase tracking-widest">
              Session controls
            </p>
            <VoiceWave
              active={isCallActive && !isSpeaking}
              level={volumeLevel}
            />
            <p role="status" className="text-center text-xs font-semibold">
              {isCallActive
                ? isSpeaking
                  ? `${current.agent} is responding`
                  : isListening
                    ? 'Listening to you'
                    : 'Processing your question'
                : useTextMode
                  ? 'Text conversation'
                  : `${current.agent} is ready`}
            </p>
            <p className="text-[10px] text-muted text-center mt-2 mb-5">
              {current.lang} · {current.name}
            </p>
            <div className="space-y-2">
              <label className="signal-tile !p-3 flex gap-3 items-start text-xs mb-3">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={guidedMode}
                  disabled={isTextProcessing || isConnecting}
                  onChange={(event) => setGuidedMode(event.target.checked)}
                />
                <span>
                  <strong className="block">Require approval before replying</strong>
                  <span className="block text-muted mt-1 leading-5">
                    When enabled, pause grounded answers until you approve a live tip.
                  </span>
                </span>
              </label>
              {!isCallActive && !useTextMode && (
                <button
                  onClick={startCall}
                  disabled={isConnecting || isTextProcessing}
                  className="btn btn-primary w-full"
                >
                  <Phone size={15} />
                  {restoringSession ? 'Restoring session…' : isConnecting ? 'Connecting…' : 'Start Voice Call'}
                </button>
              )}
              {(isCallActive || hasSession) && (
                <button
                  onClick={endCall}
                  disabled={isConnecting || isTextProcessing}
                  className="btn btn-danger w-full"
                >
                  <PhoneOff size={15} />
                  {callState === 'ending'
                    ? 'Saving session…'
                    : isCallActive
                      ? 'End Call'
                      : 'End Session'}
                </button>
              )}
            </div>
            <p className="text-[10px] text-muted leading-5 mt-4">
              {hasSession
                ? 'End the session to save it to Call History. Agent selection is locked during a session.'
                : useTextMode
                  ? 'Send your first question to open a session.'
                  : 'Allow microphone access to begin. Text mode is always available.'}
            </p>
          </div>
          {hasSession && (
            <div className="border-t mt-5 pt-5">
              <form onSubmit={requestPrivateGuidance} className="signal-tile !p-3 mb-5 space-y-3">
                <div>
                  <h2 className="text-xs font-semibold flex items-center gap-2">
                    <Search size={14} className="text-accent" /> Ask Veyra privately
                  </h2>
                  <p id="private-guidance-help" className="text-[10px] text-muted mt-1 leading-5">
                    Search approved knowledge without adding this question to the customer transcript.
                  </p>
                </div>
                <label className="block text-xs text-muted">
                  Operator question
                  <textarea
                    value={guidanceQuestion}
                    maxLength={8000}
                    rows={3}
                    disabled={guidanceBusy || callState === 'ending'}
                    aria-describedby="private-guidance-help"
                    placeholder="For example: What should I say about prepayment charges?"
                    onChange={(event) => setGuidanceQuestion(event.target.value)}
                    className="field mt-2 resize-y"
                  />
                </label>
                <button
                  type="submit"
                  disabled={guidanceBusy || !guidanceQuestion.trim() || callState === 'ending'}
                  className="btn w-full"
                >
                  <Search size={15} /> {guidanceBusy ? 'Searching…' : 'Find grounded reply'}
                </button>
                {guidanceMessage && <p role="status" className="text-xs text-muted">{guidanceMessage}</p>}
                {guidanceError && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{guidanceError}</p>}
              </form>
              <div className="mb-5">
                <LivePlaybook
                  callId={sessionIdRef.current}
                  turnCount={messages.length}
                  onPrepareGuidance={preparePrivateGuidance}
                />
              </div>
              <div className="mb-5">
                <LiveDisclosureChecklist
                  callId={sessionIdRef.current}
                  turnCount={messages.length}
                  onNavigateEvidence={navigateToChecklistEvidence}
                />
              </div>
              <NudgeFeed
                callId={sessionIdRef.current}
                title="Live guidance"
                onApply={applyGuidedNudge}
                applyLabel={useTextMode ? 'Add reply' : 'Speak now'}
              />
            </div>
          )}
        </aside>
        <section
          className="panel conversation-panel"
          aria-label="Conversation transcript"
        >
          <div className="conversation-header">
            <div>
              <h2 className="panel-title">Conversation</h2>
              <p className="panel-description">
                {messages.length} turns · {current.agent}
              </p>
            </div>
            <div className="segmented" aria-label="Conversation mode">
              <button
                aria-pressed={!useTextMode}
                disabled={isCallActive || isConnecting || isTextProcessing}
                onClick={() => setUseTextMode(false)}
              >
                Voice
              </button>
              <button
                aria-pressed={useTextMode}
                disabled={isCallActive || isConnecting || isTextProcessing}
                onClick={() => setUseTextMode(true)}
              >
                Text Mode
              </button>
            </div>
          </div>
          <div
            className="conversation-messages"
            role="log"
            aria-label="Live transcript"
            aria-relevant="additions text"
          >
            {!messages.length && !partialTranscript && (
              <EmptyState
                icon={useTextMode ? Send : Mic}
                title={
                  useTextMode
                    ? 'Start with a question'
                    : 'A conversation starts with listening'
                }
              >
                {useTextMode
                  ? `Ask ${current.agent} a question about ${current.name.toLowerCase()}. Answers and supporting sources appear here.`
                  : 'Start a voice call to see the live transcript, responses, and supporting knowledge in one place.'}
              </EmptyState>
            )}
            {messages.map((msg, index) => (
              <MessageBubble key={msg.id} msg={msg} turnIndex={index} />
            ))}
            {partialTranscript && (
              <MessageBubble
                msg={{
                  role: 'user',
                  content: partialTranscript,
                  isPartial: true,
                }}
              />
            )}
            {isTextProcessing && (
              <p role="status" className="text-xs text-muted">
                Checking knowledge for your answer…
              </p>
            )}
            <div ref={chatEndRef} />
          </div>
          {useTextMode ? (
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                handleTextQuery();
              }}
            >
              <input
                type="text"
                aria-label="Ask the agent"
                value={inputText}
                onChange={(event) => setInputText(event.target.value)}
                placeholder={`Ask ${current.agent} a question…`}
                className="field flex-1"
                disabled={isTextProcessing || isConnecting}
              />
              <button
                type="submit"
                disabled={isTextProcessing || isConnecting || !inputText.trim()}
                className="btn btn-primary"
              >
                <Send size={15} />
                <span>Ask</span>
              </button>
            </form>
          ) : (
            <div className="composer text-[11px] text-muted">
              <Mic size={14} />
              {isCallActive
                ? 'Your transcript appears as you speak.'
                : 'Choose an agent and start a voice call, or switch to Text Mode.'}
            </div>
          )}
        </section>
      </div>
      <details className="panel !py-4">
        <summary className="cursor-pointer text-xs font-semibold text-muted">
          Session diagnostics{' '}
          {totalCallLatency != null
            ? `· Last gateway reply ${totalCallLatency} ms`
            : ''}
        </summary>
        <p className="text-xs text-muted mt-4 leading-6">
          Recorded service timings are shown when available. Gateway reply time
          does not measure the complete speech-to-audio experience.
        </p>
        <dl className="grid sm:grid-cols-3 gap-4 mt-4">
          {[
            ['Knowledge retrieval', latencies.rag],
            ['Answer generation', latencies.llm],
            ['Gateway overhead', latencies.gateway],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-[10px] text-muted">{label}</dt>
              <dd className="text-sm tabular-nums mt-2">
                {Number.isFinite(value) && value >= 0
                  ? `${Math.round(value)} ms`
                  : 'Not measured'}
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}
