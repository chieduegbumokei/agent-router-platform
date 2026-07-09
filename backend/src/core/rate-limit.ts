/**
 * In-memory token bucket. Per-process by design: locally that is global;
 * on Lambda it is per-instance, which still bounds abuse per connection -
 * production would move this to API Gateway usage plans or DynamoDB counters
 * (documented trade-off in the README).
 */
interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private capacity: number,
    private refillPerMinute: number,
  ) {}

  /** Returns true if the call is allowed, false if rate-limited. */
  take(key: string, now = Date.now()): boolean {
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, lastRefill: now };
      this.buckets.set(key, b);
    }
    const elapsedMin = (now - b.lastRefill) / 60_000;
    b.tokens = Math.min(this.capacity, b.tokens + elapsedMin * this.refillPerMinute);
    b.lastRefill = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}
