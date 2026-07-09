import { describe, expect, it } from 'vitest';
import { groupByRecency } from '../src/lib/dates';

// Fixed "now": Tuesday 2026-07-07 15:00 local time
const NOW = new Date(2026, 6, 7, 15, 0, 0);

const conv = (id: string, at: string) => ({ id, at });

describe('conversation recency grouping', () => {
  it('buckets into Today / Yesterday / Previous 7 days / Older', () => {
    const groups = groupByRecency(
      [
        conv('a', new Date(2026, 6, 7, 9, 0).toISOString()), // today morning
        conv('b', new Date(2026, 6, 6, 23, 30).toISOString()), // yesterday night
        conv('c', new Date(2026, 6, 2, 12, 0).toISOString()), // 5 days ago
        conv('d', new Date(2026, 5, 1).toISOString()), // last month
      ],
      (c) => c.at,
      NOW,
    );
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Previous 7 days', 'Older']);
    expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([['a'], ['b'], ['c'], ['d']]);
  });

  it('omits empty buckets and preserves input order within a bucket', () => {
    const groups = groupByRecency(
      [conv('new', new Date(2026, 6, 7, 14, 0).toISOString()), conv('old', new Date(2026, 6, 7, 1, 0).toISOString())],
      (c) => c.at,
      NOW,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe('Today');
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['new', 'old']);
  });

  it('treats midnight boundaries correctly', () => {
    const startOfToday = new Date(2026, 6, 7, 0, 0, 0).toISOString();
    const endOfYesterday = new Date(2026, 6, 6, 23, 59, 59).toISOString();
    const groups = groupByRecency(
      [conv('t', startOfToday), conv('y', endOfYesterday)],
      (c) => c.at,
      NOW,
    );
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday']);
  });

  it('puts unparseable dates in Today rather than losing them', () => {
    const groups = groupByRecency([conv('x', 'not-a-date')], (c) => c.at, NOW);
    expect(groups[0]!.label).toBe('Today');
    expect(groups[0]!.items).toHaveLength(1);
  });
});
