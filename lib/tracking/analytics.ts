const SKIPPED_PREFIX = "SKIPPED_";

export interface StatusCountRow {
  status: string;
  _count: number | { status?: number; _all?: number };
}

export interface KeywordCountRow {
  matchedKeyword: string | null;
  _count: number | { matchedKeyword?: number; _all?: number };
}

function getCount(value: StatusCountRow["_count"] | KeywordCountRow["_count"]) {
  if (typeof value === "number") return value;
  if ("status" in value && typeof value.status === "number") {
    return value.status;
  }
  if ("matchedKeyword" in value && typeof value.matchedKeyword === "number") {
    return value.matchedKeyword;
  }
  return value._all ?? 0;
}

export function calculateCtr(clicks: number, sent: number) {
  if (sent <= 0) return 0;
  // Raw clicks can exceed sends (repeat clicks, link-preview bots hitting the
  // tracked URL), which makes a "rate" over 100% — cap it so CTR stays sane.
  return Math.min(100, Number(((clicks / sent) * 100).toFixed(1)));
}

export function summarizeDmStatuses(rows: StatusCountRow[]) {
  return rows.reduce(
    (summary, row) => {
      const count = getCount(row._count);
      if (row.status === "SENT") summary.sent += count;
      if (row.status === "FAILED") summary.failed += count;
      if (row.status.startsWith(SKIPPED_PREFIX)) summary.skipped += count;
      return summary;
    },
    { sent: 0, skipped: 0, failed: 0 }
  );
}

export function normalizeTopKeywords(rows: KeywordCountRow[], limit = 5) {
  return rows
    .filter((row) => row.matchedKeyword)
    .map((row) => ({
      keyword: row.matchedKeyword as string,
      count: getCount(row._count),
    }))
    .sort((a, b) => b.count - a.count || a.keyword.localeCompare(b.keyword))
    .slice(0, limit);
}

export interface DayBucket {
  /** Weekday label, e.g. "Mon". */
  date: string;
  start: Date;
  end: Date;
}

/**
 * The contiguous day-buckets a "DMs per day" chart plots, oldest first.
 *
 * Every boundary is derived the way the label is — local-time `setDate` from
 * local midnight — so the edge of a bucket and the weekday it is named after
 * cannot disagree, including across a DST change. That is also why callers
 * bucket rows against these Dates in memory rather than asking Postgres for
 * `date_trunc`, which would truncate in the database's timezone while the label
 * is written in the runtime's.
 */
export function dailyDmBuckets(todayStart: Date, days = 7): DayBucket[] {
  return Array.from({ length: days }, (_, index) => {
    const start = new Date(todayStart);
    start.setDate(start.getDate() - (days - 1 - index));
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return {
      date: start.toLocaleDateString("en-US", { weekday: "short" }),
      start,
      end,
    };
  });
}

/**
 * Counts per bucket, including the zero-count days the chart still has to plot.
 * Timestamps outside every bucket are ignored, so an over-wide query cannot
 * inflate an edge day.
 */
export function countPerDay(
  buckets: readonly DayBucket[],
  timestamps: readonly Date[]
): { date: string; count: number }[] {
  const counts = buckets.map((bucket) => ({ date: bucket.date, count: 0 }));
  for (const timestamp of timestamps) {
    const index = buckets.findIndex(
      (bucket) => timestamp >= bucket.start && timestamp < bucket.end
    );
    if (index !== -1) counts[index].count += 1;
  }
  return counts;
}
