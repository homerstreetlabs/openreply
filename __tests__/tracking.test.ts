import { describe, expect, it } from "vitest";
import {
  calculateCtr,
  countPerDay,
  dailyDmBuckets,
  normalizeTopKeywords,
  summarizeDmStatuses,
} from "../lib/tracking/analytics";
import {
  buildTrackedUrl,
  extractFirstUrl,
  renderMessageWithTracking,
  replaceUrlWithTrackedPlaceholder,
} from "../lib/tracking/message";

describe("tracked link messages", () => {
  it("extracts a destination URL and replaces it with the tracked placeholder", () => {
    const message =
      "Hey {username}, here is your guide: https://example.com/guide.";
    const url = extractFirstUrl(message);

    expect(url).toBe("https://example.com/guide");
    expect(replaceUrlWithTrackedPlaceholder(message, url)).toBe(
      "Hey {username}, here is your guide: {link}."
    );
  });

  it("renders tracked URLs with username personalization", () => {
    expect(
      renderMessageWithTracking({
        message: "Hey {username}, grab it here: {link}",
        commenterName: "Maya",
        trackedLinks: [
          {
            slug: "abc123",
            destinationUrl: "https://example.com/guide",
          },
        ],
        baseUrl: "https://manychat-alternative.com",
      })
    ).toBe("Hey Maya, grab it here: https://manychat-alternative.com/r/abc123");
  });

  it("can replace a raw destination URL when the placeholder is missing", () => {
    expect(
      renderMessageWithTracking({
        message: "Link: https://example.com/guide",
        trackedLinks: [
          {
            slug: "abc123",
            destinationUrl: "https://example.com/guide",
          },
        ],
        baseUrl: "https://manychat-alternative.com/",
      })
    ).toBe("Link: https://manychat-alternative.com/r/abc123");
  });

  it("matches normalized root URLs with or without trailing slash", () => {
    expect(
      replaceUrlWithTrackedPlaceholder("Link: https://example.com", "https://example.com/")
    ).toBe("Link: {link}");
    expect(
      renderMessageWithTracking({
        message: "Link: https://example.com",
        trackedLinks: [
          {
            slug: "abc123",
            destinationUrl: "https://example.com/",
          },
        ],
        baseUrl: "https://manychat-alternative.com",
      })
    ).toBe("Link: https://manychat-alternative.com/r/abc123");
  });

  it("builds redirect URLs from a base URL", () => {
    expect(buildTrackedUrl("abc123", "https://manychat-alternative.com/")).toBe(
      "https://manychat-alternative.com/r/abc123"
    );
  });
});

describe("campaign analytics helpers", () => {
  it("summarizes DM status rows", () => {
    expect(
      summarizeDmStatuses([
        { status: "SENT", _count: 20 },
        { status: "FAILED", _count: 2 },
        { status: "SKIPPED_RATE_LIMIT", _count: 3 },
        { status: "SKIPPED_PLAN_LIMIT", _count: 1 },
      ])
    ).toEqual({ sent: 20, skipped: 4, failed: 2 });
  });

  it("calculates CTR and handles empty send volume", () => {
    expect(calculateCtr(5, 20)).toBe(25);
    expect(calculateCtr(2, 3)).toBe(66.7);
    expect(calculateCtr(5, 0)).toBe(0);
  });

  it("normalizes top keywords by count", () => {
    expect(
      normalizeTopKeywords([
        { matchedKeyword: "PRICE", _count: 3 },
        { matchedKeyword: null, _count: 9 },
        { matchedKeyword: "LINK", _count: 7 },
      ])
    ).toEqual([
      { keyword: "LINK", count: 7 },
      { keyword: "PRICE", count: 3 },
    ]);
  });
});

/**
 * These buckets replaced seven serial `responseRun.count` round trips on
 * /api/dashboard/stats. The output shape has to be identical to what that loop
 * produced, so the reference implementation below is the loop, and the tests
 * compare against it rather than against hand-written expectations.
 */
describe("daily DM buckets", () => {
  /** The boundaries the old per-day loop computed, kept as the oracle. */
  function loopBoundaries(todayStart: Date) {
    const days: { date: string; start: Date; end: Date }[] = [];
    for (let i = 6; i >= 0; i--) {
      const dayStart = new Date(todayStart);
      dayStart.setDate(dayStart.getDate() - i);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);
      days.push({
        date: dayStart.toLocaleDateString("en-US", { weekday: "short" }),
        start: dayStart,
        end: dayEnd,
      });
    }
    return days;
  }

  const cases = [
    ["an ordinary week", new Date(2026, 7, 27)],
    ["a spring-forward week", new Date(2026, 2, 11)],
    ["a fall-back week", new Date(2026, 10, 4)],
    ["a month boundary", new Date(2026, 0, 2)],
    ["a leap day", new Date(2028, 1, 29)],
  ] as const;

  for (const [name, todayStart] of cases) {
    it(`matches the per-day loop's boundaries and labels across ${name}`, () => {
      expect(dailyDmBuckets(todayStart)).toEqual(loopBoundaries(todayStart));
    });
  }

  it("labels seven consecutive weekdays ending today, oldest first", () => {
    const buckets = dailyDmBuckets(new Date(2026, 7, 27));

    expect(buckets.map((bucket) => bucket.date)).toEqual([
      "Fri",
      "Sat",
      "Sun",
      "Mon",
      "Tue",
      "Wed",
      "Thu",
    ]);
  });

  it("covers the window with no gap between one bucket and the next", () => {
    const buckets = dailyDmBuckets(new Date(2026, 2, 11));

    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i].start.getTime()).toBe(buckets[i - 1].end.getTime());
    }
  });

  it("counts each timestamp into the same bucket the loop's range would have", () => {
    const todayStart = new Date(2026, 7, 27);
    const buckets = dailyDmBuckets(todayStart);
    const timestamps = [
      new Date(2026, 7, 21, 0, 0, 0),
      new Date(2026, 7, 21, 23, 59, 59, 999),
      new Date(2026, 7, 24, 12, 0, 0),
      new Date(2026, 7, 24, 12, 0, 1),
      new Date(2026, 7, 27, 9, 30, 0),
    ];

    const oracle = loopBoundaries(todayStart).map((day) => ({
      date: day.date,
      count: timestamps.filter((at) => at >= day.start && at < day.end).length,
    }));

    expect(countPerDay(buckets, timestamps)).toEqual(oracle);
  });

  it("keeps zero-count days rather than dropping them", () => {
    const todayStart = new Date(2026, 7, 27);

    const counts = countPerDay(dailyDmBuckets(todayStart), [
      new Date(2026, 7, 25, 8, 0, 0),
    ]);

    expect(counts).toHaveLength(7);
    expect(counts.map((day) => day.count)).toEqual([0, 0, 0, 0, 1, 0, 0]);
  });

  it("ignores timestamps outside the window", () => {
    const todayStart = new Date(2026, 7, 27);

    const counts = countPerDay(dailyDmBuckets(todayStart), [
      new Date(2026, 7, 20, 23, 59, 59),
      new Date(2026, 7, 28, 0, 0, 0),
    ]);

    expect(counts.every((day) => day.count === 0)).toBe(true);
  });
});
