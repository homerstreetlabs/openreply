"use client";

import type { Platform } from "@/app/generated/prisma/client";

/**
 * What a picker needs to name an account. Structurally the directory's
 * `ConnectedAccountRef`, so a list fetched from `/api/accounts` drops straight
 * in and the label is not re-derived here.
 */
export interface AccountOption {
  id: string;
  /** Already `@`-prefixed where the platform uses handles. */
  label: string;
  username: string;
  externalId: string;
  /** Drives which campaign options are offered, via the adapter's capabilities. */
  platform: Platform;
}

interface AccountSelectProps {
  accounts: AccountOption[];
  value: string;
  onChange: (value: string) => void;
  includeAll?: boolean;
  label?: string;
}

export default function AccountSelect({
  accounts,
  value,
  onChange,
  includeAll = true,
  label = "Account",
}: AccountSelectProps) {
  return (
    <label className="flex flex-col gap-2 text-sm">
      <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-52 rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40"
      >
        {includeAll && <option value="all">All accounts</option>}
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.label}
          </option>
        ))}
      </select>
    </label>
  );
}

