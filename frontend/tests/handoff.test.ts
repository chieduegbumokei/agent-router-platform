import { beforeEach, describe, expect, it } from 'vitest';
import { setPendingChat, takePendingChat, type PendingChat } from '../src/lib/handoff';

const chat = (over: Partial<PendingChat> = {}): PendingChat => ({
  text: 'hello',
  attachments: [],
  ...over,
});

// The module holds one-shot state at module scope; drain it before each test so
// ordering can never leak a pending chat from one case into the next.
beforeEach(() => {
  takePendingChat();
});

describe('pending chat handoff', () => {
  it('returns null when nothing is pending', () => {
    expect(takePendingChat()).toBeNull();
  });

  it('hands the stored chat to the next reader', () => {
    const pending = chat({ text: 'from the project composer', projectId: 'p1' });
    setPendingChat(pending);
    expect(takePendingChat()).toEqual(pending);
  });

  it('is one-shot: a second read gets null', () => {
    setPendingChat(chat());
    expect(takePendingChat()).not.toBeNull();
    expect(takePendingChat()).toBeNull();
  });

  it('overwrites an unconsumed pending chat with the latest one', () => {
    setPendingChat(chat({ text: 'first' }));
    setPendingChat(chat({ text: 'second' }));
    expect(takePendingChat()?.text).toBe('second');
    expect(takePendingChat()).toBeNull();
  });
});
