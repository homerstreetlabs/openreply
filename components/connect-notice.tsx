"use client";

import { useSearchParams } from "next/navigation";
import { Platform } from "@/app/generated/prisma/browser";
import { platformName } from "@/lib/campaigns/options";

type Tone = "error" | "warning" | "success";

const TONE_CLASSES = {
  error: "border-error/20 bg-error/10 text-error",
  warning: "border-warning/20 bg-warning/10 text-warning",
  success: "border-success/20 bg-success/10 text-success",
} satisfies Record<Tone, string>;

/** Every outcome `/api/connect/[platform]/callback` redirects back with. */
const OUTCOMES = {
  ok: {
    tone: "success",
    title: (name: string) => `${name} connected`,
    detail: () => "Campaigns can now run on it.",
  },
  denied: {
    tone: "warning",
    title: () => "Connection cancelled",
    detail: () => "The permission prompt was declined. Start again and accept every requested permission.",
  },
  invalid_state: {
    tone: "error",
    title: () => "Connection expired",
    detail: () => "The login link was missing or older than 15 minutes. Click Connect to start a fresh attempt.",
  },
  nothing_to_connect: {
    tone: "warning",
    title: (name: string) => `No ${name} account found`,
    detail: (name: string) =>
      `The login worked, but ${name} returned no account to connect. Check that you signed in with the account that owns the channel or profile.`,
  },
  already_connected: {
    tone: "warning",
    title: () => "Already connected to another workspace",
    detail: (name: string, count: number) =>
      `${count > 0 ? `${count} connected. ` : ""}An account from this ${name} login belongs to another workspace. Disconnect it there first, or sign in with a different account.`,
  },
  failed: {
    tone: "error",
    title: (name: string) => `${name} connection failed`,
    detail: () => "The login was accepted but the connection could not be completed. Try again, and contact support if it keeps failing.",
  },
} satisfies Record<
  string,
  { tone: Tone; title: (name: string) => string; detail: (name: string, count: number) => string }
>;

function isOutcome(value: string | null): value is keyof typeof OUTCOMES {
  return value !== null && Object.hasOwn(OUTCOMES, value);
}

export function ConnectNotice() {
  const searchParams = useSearchParams();
  const outcome = searchParams.get("connect");
  if (!isOutcome(outcome)) return null;

  const known = OUTCOMES[outcome];
  const platform = Object.values(Platform).find((p) => p === searchParams.get("platform"));
  const name = platform ? platformName(platform) : "Account";
  const count = Number(searchParams.get("count") ?? 0);

  return (
    <div className={`rounded border p-4 text-sm ${TONE_CLASSES[known.tone]}`}>
      <p className="font-semibold">{known.title(name)}</p>
      <p className="mt-1 opacity-90">{known.detail(name, count)}</p>
    </div>
  );
}
