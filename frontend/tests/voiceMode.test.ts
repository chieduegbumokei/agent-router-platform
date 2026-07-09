// @vitest-environment happy-dom
import { createElement } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceMode, type VoiceReply } from '@/components/VoiceMode';

/** A hand-drivable stand-in for the browser SpeechRecognition. */
class MockRecognition {
  continuous = false;
  interimResults = false;
  lang = '';
  onresult: ((e: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
  static instances: MockRecognition[] = [];
  static get current() {
    return MockRecognition.instances[MockRecognition.instances.length - 1] ?? null;
  }
  constructor() {
    MockRecognition.instances.push(this);
  }
}

const spokenTexts: string[] = [];

class MockUtterance {
  text: string;
  lang = '';
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

/** Build the ArrayLike-of-ArrayLike shape the component reads from onresult. */
function resultEvent(transcript: string, isFinal = true) {
  const results = [Object.assign([{ transcript }], { isFinal })];
  return { resultIndex: 0, results };
}

function renderVoice(reply: VoiceReply | null, streaming = false) {
  const onSend = vi.fn();
  const onStop = vi.fn();
  const onClose = vi.fn();
  const view = render(
    createElement(VoiceMode, { streaming, reply, onSend, onStop, onClose }),
  );
  // The mount effect defers the first start by a tick (StrictMode-safety); flush it.
  act(() => {
    vi.advanceTimersByTime(1);
  });
  return { ...view, onSend, onStop, onClose };
}

beforeEach(() => {
  vi.useFakeTimers();
  MockRecognition.instances = [];
  spokenTexts.length = 0;
  (window as unknown as Record<string, unknown>).SpeechRecognition = MockRecognition;
  (window as unknown as Record<string, unknown>).SpeechSynthesisUtterance = MockUtterance;
  (window as unknown as Record<string, unknown>).speechSynthesis = {
    // Speak synchronously: fire onend so the loop advances back to listening.
    speak: (u: MockUtterance) => {
      spokenTexts.push(u.text);
      u.onend?.();
    },
    cancel: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as unknown as Record<string, unknown>).SpeechRecognition;
  delete (window as unknown as Record<string, unknown>).SpeechSynthesisUtterance;
  delete (window as unknown as Record<string, unknown>).speechSynthesis;
});

describe('VoiceMode loop', () => {
  it('starts listening on open', () => {
    renderVoice(null);
    expect(MockRecognition.instances.length).toBe(1);
    expect(MockRecognition.current?.start).toHaveBeenCalled();
  });

  it('auto-sends after a pause, then speaks the reply and listens again', () => {
    const { rerender, onSend } = renderVoice(null);

    // User speaks.
    act(() => {
      MockRecognition.current?.onresult?.(resultEvent('what is the capital of France'));
    });
    // No send yet — still within the silence window.
    expect(onSend).not.toHaveBeenCalled();

    // Pause long enough to count as "done talking".
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(onSend).toHaveBeenCalledWith('what is the capital of France');
    expect(MockRecognition.current?.stop).toHaveBeenCalled();

    // Reply streams in…
    act(() => {
      rerender(
        createElement(VoiceMode, {
          streaming: true,
          reply: { id: 'a1', text: 'Paris', streaming: true },
          onSend,
          onStop: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });
    expect(spokenTexts).toHaveLength(0); // don't speak until it's done

    const before = MockRecognition.instances.length;

    // …and finishes.
    act(() => {
      rerender(
        createElement(VoiceMode, {
          streaming: false,
          reply: { id: 'a1', text: 'The capital of France is Paris.', streaming: false },
          onSend,
          onStop: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });

    // It read the answer aloud…
    expect(spokenTexts.join(' ')).toContain('Paris');
    // …and reopened the mic for the next turn.
    expect(MockRecognition.instances.length).toBeGreaterThan(before);
  });

  it('does not re-speak a reply that was already on screen when opened', () => {
    // Opening mid-conversation with an existing assistant message.
    renderVoice({ id: 'existing', text: 'Earlier answer.', streaming: false });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(spokenTexts).toHaveLength(0);
  });
});
