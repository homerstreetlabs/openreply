import Link from "next/link";
import { platformName } from "@/lib/campaigns/options";
import type { ConnectedAccountRef, PlatformGroup } from "@/lib/accounts/directory";

/**
 * One pill per platform that actually has a connected account, and an account
 * row beneath when a platform has more than one.
 *
 * Links rather than client state. Each account is its own URL, so the browser
 * prefetches on hover, the back button works, and a creator can send someone a
 * link to the account they are talking about.
 */
export default function PlatformPills({
  groups,
  activeId,
  hrefFor,
}: {
  groups: readonly PlatformGroup[];
  activeId: string;
  hrefFor: (account: ConnectedAccountRef) => string;
}) {
  if (groups.length === 0) return null;

  const activePlatform = groups.find((group) =>
    group.accounts.some((account) => account.id === activeId)
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Platform">
        {groups.map((group) => {
          const isActive = group.platform === activePlatform?.platform;
          // Land on the platform's most recently connected account, which is
          // the one a creator is most likely to be asking about.
          const target = group.accounts[0];
          return (
            <Link
              key={group.platform}
              href={hrefFor(target)}
              role="tab"
              aria-selected={isActive}
              className={`rounded-full border px-4 py-1.5 text-sm font-medium transition-colors ${
                isActive
                  ? "border-accent/30 bg-accent/10 text-accent"
                  : "border-border text-muted hover:border-border-hover hover:text-foreground"
              }`}
            >
              {platformName(group.platform)}
              {group.accounts.length > 1 && (
                <span className="ml-2 text-xs opacity-70">
                  {group.accounts.length}
                </span>
              )}
            </Link>
          );
        })}
      </div>

      {activePlatform && activePlatform.accounts.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {activePlatform.accounts.map((account) => (
            <Link
              key={account.id}
              href={hrefFor(account)}
              aria-current={account.id === activeId ? "page" : undefined}
              className={`rounded border px-3 py-1 text-xs transition-colors ${
                account.id === activeId
                  ? "border-accent/30 bg-accent/10 text-accent"
                  : "border-border text-muted hover:border-border-hover hover:text-foreground"
              }`}
            >
              {account.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
