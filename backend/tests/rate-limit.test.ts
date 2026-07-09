import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/core/rate-limit';

describe('RateLimiter', () => {
  it('allows exactly `capacity` calls before blocking (time frozen)', () => {
    const rl = new RateLimiter(3, 0);
    expect(rl.take('ip', 0)).toBe(true);
    expect(rl.take('ip', 0)).toBe(true);
    expect(rl.take('ip', 0)).toBe(true);
    expect(rl.take('ip', 0)).toBe(false); // bucket drained
  });

  it('tracks buckets per key independently', () => {
    const rl = new RateLimiter(1, 0);
    expect(rl.take('a', 0)).toBe(true);
    expect(rl.take('a', 0)).toBe(false);
    expect(rl.take('b', 0)).toBe(true); // b has its own bucket
  });

  it('refills over time and lets a blocked key through again', () => {
    const rl = new RateLimiter(2, 2); // 2 tokens/min
    expect(rl.take('ip', 0)).toBe(true);
    expect(rl.take('ip', 0)).toBe(true);
    expect(rl.take('ip', 0)).toBe(false);
    // one minute later, 2 tokens have refilled
    expect(rl.take('ip', 60_000)).toBe(true);
  });

  it('refills partially: half a minute at 2/min yields one token', () => {
    const rl = new RateLimiter(2, 2);
    rl.take('ip', 0);
    rl.take('ip', 0); // drained
    expect(rl.take('ip', 0)).toBe(false);
    expect(rl.take('ip', 30_000)).toBe(true); // +1 token at 30s
    expect(rl.take('ip', 30_000)).toBe(false); // but only one
  });

  it('never accumulates beyond capacity while idle', () => {
    const rl = new RateLimiter(2, 100); // huge refill rate
    expect(rl.take('ip', 0)).toBe(true); // 1 left
    // 10 minutes idle would add 1000 tokens, but capacity caps at 2
    expect(rl.take('ip', 600_000)).toBe(true);
    expect(rl.take('ip', 600_000)).toBe(true);
    expect(rl.take('ip', 600_000)).toBe(false); // still only `capacity` available
  });
});
