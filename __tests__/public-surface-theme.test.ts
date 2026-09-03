/**
 * Public surface theme — Unit Test
 *
 * The regression this locks down: the light-theme conversion flipped the tokens
 * in globals.css but never reached the signed-out pages, so headings rendered
 * white on white at 1.00:1. A browser audit of the eleven public routes counted
 * 237 elements below WCAG AA.
 *
 * The guard bans palette literals rather than asserting a contrast number,
 * which a unit test cannot measure.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SURFACE = [
  "app/invite/[token]/page.tsx",
  "app/join/[token]/page.tsx",
  "app/templates/page.tsx",
  "app/templates/[slug]/page.tsx",
  "app/reports/[shareSlug]/page.tsx",
  "components/seo-page-shell.tsx",
  "components/public-site-header.tsx",
  "components/template-visual.tsx",
];

const PALETTE =
  /(?:hover:|focus:|active:)?(?:text|bg|border|ring|divide|from|via|to)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(?:-\d{2,3})?(?:\/(?:\[[^\]]+\]|\d+))?/g;

/**
 * The one literal that still belongs. An accent button's label is white
 * because the accent is orange, not because the page behind it is dark.
 */
const isAccentButtonLabel = (className: string, token: string) =>
  token === "text-white" && /(?<![\w/-])bg-accent(?![\w/-])/.test(className);

const offenders = (file: string) => {
  const source = readFileSync(path.join(process.cwd(), file), "utf8");
  const found: string[] = [];
  for (const [, quoted, templated] of source.matchAll(
    /className=(?:"([^"]*)"|\{`([^`]*)`\})/g,
  )) {
    const className = quoted ?? templated ?? "";
    for (const token of className.match(PALETTE) ?? []) {
      if (!isAccentButtonLabel(className, token)) found.push(token);
    }
  }
  return found;
};

describe("public surface", () => {
  it.each(SURFACE)("%s paints from design tokens", (file) => {
    expect(offenders(file)).toEqual([]);
  });

  it("still allows a white label on the accent button", () => {
    expect(isAccentButtonLabel("bg-accent px-6 text-white", "text-white")).toBe(true);
    expect(isAccentButtonLabel("bg-surface px-6 text-white", "text-white")).toBe(false);
  });
});
