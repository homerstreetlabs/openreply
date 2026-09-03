/**
 * Invite page theme — Unit Test
 *
 * The regression this locks down: the light-theme conversion flipped the tokens
 * in globals.css and repainted the surfaces it touched, but never reached
 * /invite/[token]. The page kept its dark-era classes, so the "Join <workspace>"
 * heading rendered white on white at a 1.00:1 contrast ratio, the eyebrow and
 * wordmark sat at 1.12:1, and the person clicking the emailed link could not
 * read who had invited them or to what.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SOURCE = readFileSync(
  path.join(process.cwd(), "app/invite/[token]/page.tsx"),
  "utf8",
);

/**
 * Colors that assume a dark canvas. `text-white` is legitimate on the orange
 * accent button, but that button lives in invitation-accept-card, not here, so
 * this page has no reason to name a raw palette color at all.
 */
const DARK_ERA =
  /\b(?:text-white|(?:text|bg|border)-(?:cyan|zinc|slate|neutral)-\d{2,3}|(?:text|bg|border)-white\/(?:\[[^\]]+\]|\d+))/g;

describe("invite page", () => {
  it("paints from design tokens, not the dark-era palette", () => {
    expect(SOURCE.match(DARK_ERA) ?? []).toEqual([]);
  });
});
