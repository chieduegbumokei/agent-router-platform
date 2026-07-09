import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId, newSecret, sortableNow } from '../src/core/ids';

afterEach(() => {
  vi.useRealTimers();
});

describe('newId', () => {
  it('produces a v4 UUID', () => {
    expect(newId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('is unique across calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId()));
    expect(ids.size).toBe(1000);
  });
});

describe('newSecret', () => {
  it('defaults to 32 bytes → 64 lowercase hex chars', () => {
    const s = newSecret();
    expect(s).toMatch(/^[0-9a-f]{64}$/);
  });

  it('honours a custom byte length', () => {
    expect(newSecret(8)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is unique across calls', () => {
    expect(newSecret()).not.toBe(newSecret());
  });
});

describe('sortableNow', () => {
  it('is a fixed 15-char, zero-padded, all-digit string', () => {
    const s = sortableNow();
    expect(s).toHaveLength(15);
    expect(s).toMatch(/^\d{15}$/);
  });

  it('encodes the current epoch millis (leading zeros are padding)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-08T00:00:00.000Z'));
    const s = sortableNow();
    expect(Number(s)).toBe(Date.now());
  });

  it('sorts lexicographically in the same order as time (the DynamoDB SK contract)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const earlier = sortableNow();
    vi.setSystemTime(2_000_000);
    const later = sortableNow();
    // fixed width means string comparison matches chronological order
    expect(earlier < later).toBe(true);
    expect(earlier).toHaveLength(later.length);
  });
});
