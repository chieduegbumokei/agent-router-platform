'use client';

import { AudioLines, Loader2, Mic, Square, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  chunkForSpeech,
  isArcBrowser,
  isBraveBrowser,
  markRecognitionBroken,
  speechRecognitionCtor,
  speechSynthesisSupported,
  textForSpeech,
  type SpeechRecognitionLike,
} from '@/lib/speech';

/** The latest assistant message, projected down to what voice mode cares about. */
export interface VoiceReply {
  id: string;
  text: string;
  streaming: boolean;
  error?: string;
}

interface Props {
  /** True while the assistant is generating a reply. */
  streaming: boolean;
  /** The most recent assistant message on the visible thread (or null). */
  reply: VoiceReply | null;
  onSend(text: string): void;
  onStop(): void;
  onClose(): void;
}

type Phase = 'listening' | 'thinking' | 'speaking' | 'error';

/** How long a pause counts as "done talking" before we auto-send. */
const SILENCE_MS = 1400;

const STATUS: Record<Phase, string> = {
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
  error: 'Voice mode unavailable',
};

export function VoiceMode({ streaming, reply, onSend, onStop, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>('listening');
  const [transcript, setTranscript] = useState('');
  const [lastReply, setLastReply] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  /** Non-fatal notice shown under the transcript (e.g. "no audio detected yet"). */
  const [hint, setHint] = useState<string | null>(null);
  /** Sticky warning for browsers that lack a working recognition backend (Arc/Brave). */
  const [backendWarn, setBackendWarn] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const silenceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heardRef = useRef(false); // did the current listen session produce any result?
  const finalRef = useRef(''); // final transcript accumulated this utterance
  const transcriptRef = useRef('');
  const replyRef = useRef<VoiceReply | null>(reply);
  const spokenIdRef = useRef<string | null>(reply?.id ?? null); // reply already voiced (baseline)
  const awaitingRef = useRef(false); // a send is in flight, waiting to speak the answer
  const phaseRef = useRef<Phase>('listening');
  const closedRef = useRef(false);

  // Keep refs fresh for use inside async callbacks / timers.
  replyRef.current = reply;
  transcriptRef.current = transcript;

  const goPhase = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  const clearSilence = useCallback(() => {
    if (silenceRef.current) {
      clearTimeout(silenceRef.current);
      silenceRef.current = null;
    }
  }, []);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  const stopRecognition = useCallback(() => {
    clearSilence();
    clearWatchdog();
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    if (rec) {
      rec.onresult = null;
      rec.onend = null;
      rec.onerror = null;
      try {
        // abort() releases the mic immediately so the next start() can reacquire it.
        if (rec.abort) rec.abort();
        else rec.stop();
      } catch {
        /* already stopped */
      }
    }
  }, [clearSilence, clearWatchdog]);

  // Forward-declared so listening ⇄ speaking can call each other.
  const startListeningRef = useRef<() => void>(() => {});
  const submitRef = useRef<() => void>(() => {});

  const speak = useCallback(
    (raw: string) => {
      const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
      const text = textForSpeech(raw);
      if (!synth || !text) {
        startListeningRef.current();
        return;
      }
      synth.cancel();
      goPhase('speaking');
      let resumed = false;
      const resume = () => {
        if (resumed || closedRef.current) return;
        resumed = true;
        startListeningRef.current();
      };
      const chunks = chunkForSpeech(text);
      chunks.forEach((chunk, i) => {
        const utter = new SpeechSynthesisUtterance(chunk);
        utter.lang = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
        if (i === chunks.length - 1) utter.onend = resume;
        utter.onerror = resume;
        synth.speak(utter);
      });
    },
    [goPhase],
  );

  const startListening = useCallback(() => {
    if (closedRef.current) return;
    const Ctor = speechRecognitionCtor();
    if (!Ctor) {
      goPhase('error');
      setErrorMsg('Speech recognition is not supported in this browser.');
      return;
    }
    if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
    finalRef.current = '';
    heardRef.current = false;
    setTranscript('');
    setHint(null);

    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';

    rec.onresult = (event) => {
      heardRef.current = true;
      setHint(null);
      setBackendWarn(null); // it clearly works after all
      let interim = '';
      let final = finalRef.current;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i]!;
        const chunk = res[0]!.transcript;
        if (res.isFinal) final += chunk;
        else interim += chunk;
      }
      finalRef.current = final;
      setTranscript(`${final} ${interim}`.trim());
      // Reset the "done talking" timer on every bit of speech.
      clearSilence();
      silenceRef.current = setTimeout(() => submitRef.current(), SILENCE_MS);
    };

    rec.onerror = (e) => {
      // Surface every failure — silent errors are why "nothing gets written".
      if (typeof console !== 'undefined') console.warn('[voice] recognition error:', e.error);
      const fatal = (msg: string) => {
        stopRecognition();
        goPhase('error');
        setErrorMsg(msg);
      };
      switch (e.error) {
        case 'not-allowed':
        case 'service-not-allowed':
          fatal('Microphone access is blocked. Allow it from the address-bar mic/lock icon, then reopen voice mode.');
          break;
        case 'audio-capture':
          fatal('No microphone was found. Connect one and reopen voice mode.');
          break;
        case 'network':
          // This browser's recognition can't reach a backend — remember it so the
          // composer hides voice from here on (Arc/Brave/other Chromium forks).
          markRecognitionBroken();
          fatal(
            'The speech service is unreachable. Some browsers (e.g. Arc, Brave) block it and it needs an internet connection — try Chrome or Edge while online.',
          );
          break;
        case 'no-speech':
          setHint("Didn't catch that — try speaking a little louder.");
          break;
        // 'aborted' and others: harmless — onend restarts listening.
      }
    };

    rec.onend = () => {
      // Chrome ends recognition on pauses even with continuous=true — restart.
      if (!closedRef.current && phaseRef.current === 'listening' && recognitionRef.current === rec) {
        try {
          rec.start();
        } catch {
          /* already running */
        }
      }
    };

    recognitionRef.current = rec;
    goPhase('listening');
    // start() throws InvalidStateError if a just-stopped recognition still holds
    // the mic; retry a few times so the loop reliably reacquires it.
    const tryStart = (attempt: number) => {
      if (closedRef.current || recognitionRef.current !== rec) return;
      try {
        rec.start();
      } catch {
        if (attempt < 3) setTimeout(() => tryStart(attempt + 1), 250);
      }
    };
    tryStart(0);

    // If we're "listening" but no audio arrives, say so instead of sitting silent.
    clearWatchdog();
    watchdogRef.current = setTimeout(() => {
      if (!closedRef.current && phaseRef.current === 'listening' && !heardRef.current) {
        setHint(
          'No speech detected yet. Check your mic — and note some Chromium browsers (Arc, Brave) lack the speech service; if so, use Chrome or Edge.',
        );
      }
    }, 6000);
  }, [clearSilence, clearWatchdog, goPhase, stopRecognition]);

  const submitUtterance = useCallback(() => {
    clearSilence();
    const text = (finalRef.current || transcriptRef.current).trim();
    if (!text) return; // silence with nothing said — keep listening
    stopRecognition();
    awaitingRef.current = true;
    // Baseline: everything up to the current reply is already "spoken"; only voice the next one.
    spokenIdRef.current = replyRef.current?.id ?? spokenIdRef.current;
    setTranscript(text);
    goPhase('thinking');
    onSend(text);
  }, [clearSilence, goPhase, onSend, stopRecognition]);

  startListeningRef.current = startListening;
  submitRef.current = submitUtterance;

  // Mount = open (rendered conditionally by the parent). Start the loop.
  useEffect(() => {
    closedRef.current = false;
    spokenIdRef.current = replyRef.current?.id ?? null;
    if (!speechRecognitionCtor() || !speechSynthesisSupported()) {
      goPhase('error');
      setErrorMsg('Voice mode needs speech recognition and synthesis (try Chrome, Edge, or Safari).');
      return;
    }
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      goPhase('error');
      setErrorMsg('Voice mode needs a secure page — open the app on localhost or over https.');
      return;
    }
    // Chromium forks (Arc, Brave, Vivaldi…) ship the API but usually omit the
    // Google speech backend, so recognition starts yet never returns text. Warn
    // proactively — the notice clears itself the moment any transcript arrives.
    const forkNote =
      'Voice input needs Chrome or Edge. This browser (Arc/Brave and similar) usually lacks the speech-recognition service, so it may never transcribe — open the app in Chrome or Edge.';
    if (isArcBrowser()) setBackendWarn(forkNote);
    void isBraveBrowser().then((brave) => {
      if (brave && !closedRef.current) setBackendWarn(forkNote);
    });

    // Defer the first start one tick: React 18 StrictMode mounts, unmounts, then
    // remounts in dev, and two recognitions started back-to-back fight over the
    // mic and capture nothing. The cleanup cancels the transient first start.
    const startTimer = setTimeout(() => startListening(), 0);
    return () => {
      clearTimeout(startTimer);
      closedRef.current = true;
      stopRecognition();
      if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Speak the answer once a voice-initiated reply finishes streaming.
  useEffect(() => {
    if (!awaitingRef.current || !reply) return;
    if (reply.id === spokenIdRef.current) return; // still the pre-send reply; wait for the new one
    if (reply.streaming) return; // new reply is still generating
    awaitingRef.current = false;
    spokenIdRef.current = reply.id;
    if (reply.error) {
      speak('Sorry, something went wrong. Let’s try again.');
    } else if (reply.text) {
      setLastReply(reply.text);
      speak(reply.text);
    } else if (!closedRef.current) {
      startListening(); // empty/aborted answer — just listen again
    }
  }, [reply, speak, startListening]);

  // Escape closes voice mode.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function onOrbTap() {
    if (phase === 'listening') submitUtterance(); // "I'm done — send it now"
    else if (phase === 'speaking') {
      if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
      startListening(); // barge in
    } else if (phase === 'error') onClose();
  }

  const orbIcon =
    phase === 'thinking' ? (
      <Loader2 className="voice-spin" size={20} />
    ) : phase === 'speaking' ? (
      <AudioLines size={20} />
    ) : (
      <Mic size={20} />
    );

  const hasCaption = phase === 'error' || phase === 'speaking' || Boolean(transcript);
  const caption =
    phase === 'error'
      ? errorMsg
      : phase === 'speaking'
        ? lastReply
        : transcript ||
          (phase === 'listening' ? 'Listening — speak naturally, pause when done.' : 'One moment…');

  return (
    <div className="composer" role="region" aria-label="Voice conversation">
      <div className={`voice-bar voice-bar-${phase}`}>
        <button
          type="button"
          className={`voice-orb voice-orb-${phase}`}
          onClick={onOrbTap}
          disabled={phase === 'thinking'}
          aria-label={
            phase === 'listening'
              ? 'Send now'
              : phase === 'speaking'
                ? 'Interrupt and speak'
                : STATUS[phase]
          }
          title={
            phase === 'listening' ? 'Send now' : phase === 'speaking' ? 'Tap to interrupt' : undefined
          }
        >
          {orbIcon}
        </button>

        <div className="voice-bar-body">
          <div className="voice-bar-status" aria-live="polite">
            {STATUS[phase]}
          </div>
          <div className={`voice-bar-caption${hasCaption ? '' : ' muted'}`}>{caption}</div>
          {backendWarn && phase !== 'error' && <div className="voice-bar-hint">{backendWarn}</div>}
          {hint && !backendWarn && phase !== 'error' && <div className="voice-bar-hint">{hint}</div>}
        </div>

        <div className="voice-bar-actions">
          {phase === 'thinking' && streaming && (
            <button type="button" className="voice-mini" onClick={onStop} title="Stop generating">
              <Square size={13} /> Stop
            </button>
          )}
          {phase === 'speaking' && (
            <button
              type="button"
              className="voice-mini"
              onClick={() => {
                if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
                startListening();
              }}
              title="Skip and listen"
            >
              Skip
            </button>
          )}
          <button
            type="button"
            className="voice-end-btn"
            onClick={onClose}
            aria-label="End voice mode"
            title="End voice mode (Esc)"
          >
            <X size={18} />
          </button>
        </div>
      </div>
      <div className="composer-hint voice-hint">
        Voice mode — replies appear in the chat and are read aloud. Press Esc to exit.
      </div>
    </div>
  );
}
