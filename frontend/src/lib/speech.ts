/** Shared Web Speech helpers for dictation (Composer) and hands-free voice mode. */

/** Minimal typing for the (still-prefixed) SpeechRecognition API. */
export interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult:
    | ((event: {
        resultIndex: number;
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
      }) => void)
    | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start(): void;
  stop(): void;
  abort?(): void;
}

export function speechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as (new () => SpeechRecognitionLike) | null;
}

/** Text-to-speech (used to read answers aloud in voice mode). */
export function speechSynthesisSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof window.SpeechSynthesisUtterance !== 'undefined'
  );
}

/** Voice mode needs both directions: capture the user and speak back. */
export function voiceModeSupported(): boolean {
  return speechRecognitionCtor() !== null && speechSynthesisSupported();
}

/**
 * Brave exposes the Web Speech API but disables the recognition backend, so it
 * silently never returns a transcript. Detect it to explain the failure rather
 * than hang on "Listening…". (Brave-only: Arc/Chrome/Edge lack `navigator.brave`.)
 */
export async function isBraveBrowser(): Promise<boolean> {
  try {
    const nav = navigator as unknown as { brave?: { isBrave?: () => Promise<boolean> } };
    return (await nav.brave?.isBrave?.()) === true;
  } catch {
    return false;
  }
}

/** Best-effort Arc detection: Arc injects its palette custom properties on :root. */
export function isArcBrowser(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  try {
    return getComputedStyle(document.documentElement).getPropertyValue('--arc-palette-title').trim() !== '';
  } catch {
    return false;
  }
}

/**
 * Remembered "this browser's recognition is broken" flag. Set the first time a
 * `network`/`service-not-allowed` error proves recognition can't reach a backend
 * (Arc, Brave, Vivaldi, …) so we can hide the voice affordances from then on.
 */
const RECOGNITION_BROKEN_KEY = 'speech.recognitionBroken';

export function markRecognitionBroken(): void {
  try {
    localStorage.setItem(RECOGNITION_BROKEN_KEY, '1');
  } catch {
    /* storage unavailable — nothing to persist */
  }
}

export function recognitionKnownBroken(): boolean {
  try {
    return localStorage.getItem(RECOGNITION_BROKEN_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Whether to even offer speech recognition: the API must exist, the browser must
 * not be a known-broken Chromium fork, and we must not have already seen it fail.
 * Brave is async (see isBraveBrowser) and handled by marking + re-checking.
 */
export function recognitionLikelyUsable(): boolean {
  return speechRecognitionCtor() !== null && !isArcBrowser() && !recognitionKnownBroken();
}

/** Flatten assistant markdown into something a TTS engine reads cleanly. */
export function textForSpeech(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, '. code block. ') // don't read code fences aloud
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → their label
    .replace(/^#{1,6}\s+/gm, '') // heading markers
    .replace(/[*_>#|]/g, ' ') // emphasis / blockquote / table marks
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split long text into sentence-sized chunks. Chrome's SpeechSynthesis cuts off
 * utterances longer than ~15s, so we queue short pieces instead of one big blob.
 */
export function chunkForSpeech(text: string, max = 220): string[] {
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) ?? [text];
  const chunks: string[] = [];
  let buf = '';
  for (const s of sentences) {
    if (buf && (buf + s).length > max) {
      chunks.push(buf.trim());
      buf = '';
    }
    buf += s;
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}
