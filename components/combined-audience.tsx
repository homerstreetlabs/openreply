import { platformName } from "@/lib/campaigns/options";
import type { CombinedAudience as Audience } from "@/lib/accounts/audience";

/**
 * The one number on Overview that spans platforms.
 *
 * It shows its working. The sum adds followers, subscribers and fans, which are
 * three different words for a person who chose to follow, and a creator who
 * cannot see which accounts went into the total has no way to tell a real jump
 * from a newly connected account. The breakdown is the point, not decoration.
 */
export default function CombinedAudience({ audience }: { audience: Audience }) {
  if (audience.slices.length === 0) return null;

  const counted = audience.slices.filter((slice) => slice.value !== null);
  if (counted.length === 0) return null;

  const nouns = audience.nouns.join(" + ");
  const single = counted.length === 1;

  return (
    <section className="panel rounded p-4 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-semibold text-foreground">
          {single ? "Audience" : "Total audience"}
        </h2>
        <p className="text-2xl font-semibold tabular-nums text-foreground">
          {audience.total.toLocaleString()}
        </p>
      </div>

      <p className="mt-1 text-xs text-muted">
        {single
          ? `${nouns} on ${platformName(counted[0].platform)}.`
          : `${nouns} added across ${counted.length} connected accounts. These are different things on each platform, and someone who follows you on two of them is counted twice.`}
        {audience.unavailable > 0 &&
          ` ${audience.unavailable} account${audience.unavailable === 1 ? "" : "s"} did not report a count, so the total is short by that much.`}
      </p>

      {!single && (
        <ul className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
          {audience.slices.map((slice) => (
            <li
              key={slice.accountId}
              className="flex items-baseline justify-between gap-3 text-sm"
            >
              <span className="min-w-0 truncate text-muted">
                {slice.label}
                <span className="ml-2 text-xs text-zinc-500">
                  {platformName(slice.platform)} {slice.noun}
                </span>
              </span>
              <span className="shrink-0 tabular-nums text-foreground">
                {slice.value === null ? "not reported" : slice.value.toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
