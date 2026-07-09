/** Recency bucketing for the conversation rail (Today / Yesterday / …). */

export interface RecencyGroup<T> {
  label: string;
  items: T[];
}

export function groupByRecency<T>(
  items: T[],
  getDate: (item: T) => string,
  now: Date = new Date(),
): Array<RecencyGroup<T>> {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const DAY = 24 * 60 * 60 * 1000;
  const startOfYesterday = startOfToday - DAY;
  const startOfWeek = startOfToday - 7 * DAY;

  const buckets: Array<RecencyGroup<T>> = [
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'Previous 7 days', items: [] },
    { label: 'Older', items: [] },
  ];

  for (const item of items) {
    const t = new Date(getDate(item)).getTime();
    if (Number.isNaN(t) || t >= startOfToday) buckets[0]!.items.push(item);
    else if (t >= startOfYesterday) buckets[1]!.items.push(item);
    else if (t >= startOfWeek) buckets[2]!.items.push(item);
    else buckets[3]!.items.push(item);
  }
  return buckets.filter((b) => b.items.length > 0);
}
