import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ prisma: {} }));

import { linkButtonsFor } from "../lib/runtime/execute-step";

/**
 * Production, 2026-10-08: a campaign's button text was edited
 * to "Download here", but its tracked link still carried the label every new
 * campaign's link is created with, and that label won.
 */
const link = (slug: string, label: string | null) => ({
  slug,
  label,
  destinationUrl: `https://example.com/${slug}`,
});

describe("link button titles", () => {
  it("uses the campaign's button text for the primary link", () => {
    const buttons = linkButtonsFor([link("a", "Primary campaign link")], {
      bodyText: "here",
      linkSlugs: ["a"],
      primaryLabel: "Download here",
    });

    expect(buttons.map((b) => b.title)).toEqual(["Download here"]);
  });

  it("keeps each further link's own label", () => {
    const buttons = linkButtonsFor([link("a", "Primary campaign link"), link("b", "Shop")], {
      bodyText: "here",
      linkSlugs: ["a", "b"],
      primaryLabel: "Download here",
    });

    expect(buttons.map((b) => b.title)).toEqual(["Download here", "Shop"]);
  });

  it("falls back to the link's label when the campaign has no button text", () => {
    const buttons = linkButtonsFor([link("a", "Primary campaign link")], {
      bodyText: "here",
      linkSlugs: ["a"],
      primaryLabel: null,
    });

    expect(buttons.map((b) => b.title)).toEqual(["Primary campaign link"]);
  });
});
