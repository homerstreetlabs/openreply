"use client";

/**
 * The interactive half of the inbox: thread list, open thread, composer.
 *
 * Account selection is gone from here. It lives in the URL, so this component
 * no longer tracks a selected account, seeds one from sessionStorage, guards
 * against it disappearing, or resets the open thread when it changes. What is
 * left is genuinely interactive state.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import PlatformPills from "@/components/platform-pills";
import { readCache, writeCache } from "@/lib/client-cache";
import type { ConnectedAccountRef, PlatformGroup } from "@/lib/accounts/directory";
import type { Thread, ThreadMessage } from "@/lib/platforms/types";

const POLL_MS = 12_000;
// Conversation APIs are slow — often several seconds — so a revisit paints the
// cached list immediately and revalidates behind it.
const CACHE_MAX_AGE_MS = 60_000;

const threadsKey = (accountId: string) => `inbox:threads:${accountId}`;
const messagesKey = (threadId: string) => `inbox:messages:${threadId}`;

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function InboxClient({
  account,
  groups,
  canReply,
}: {
  account: ConnectedAccountRef;
  groups: readonly PlatformGroup[];
  canReply: boolean;
}) {
  // Cached threads paint on the first render rather than after one. The
  // component is keyed by account, so this initializer runs once per mailbox.
  const [threads, setThreads] = useState<Thread[]>(
    () => readCache<Thread[]>(threadsKey(account.id), CACHE_MAX_AGE_MS).data ?? []
  );
  const [listLoading, setListLoading] = useState(
    () => readCache<Thread[]>(threadsKey(account.id), CACHE_MAX_AGE_MS).data === null
  );
  const [listError, setListError] = useState<string | null>(null);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const active = threads.find((thread) => thread.id === activeId) ?? null;

  const loadThreads = useCallback(
    async (silent: boolean) => {
      try {
        const response = await fetch(`/api/inbox/threads?accountId=${account.id}`, {
          cache: "no-store",
        });
        const payload = await response.json();
        if (payload.success) {
          setThreads(payload.data.threads);
          writeCache(threadsKey(account.id), payload.data.threads);
          setListError(null);
        } else if (!silent) {
          setListError(payload.error ?? "Could not load conversations");
        }
      } catch {
        if (!silent) setListError("Could not load conversations");
      } finally {
        setListLoading(false);
      }
    },
    [account.id]
  );

  useEffect(() => {
    // Both the first load and the poll run on a later task, so nothing in this
    // effect sets state during the render it was scheduled from. The lazy
    // initializer already decided whether the list starts out loading.
    const first = window.setTimeout(() => void loadThreads(true), 0);
    const timer = window.setInterval(() => void loadThreads(true), POLL_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [loadThreads]);

  const loadMessages = useCallback(
    async (threadId: string) => {
      try {
        const response = await fetch(
          `/api/inbox/threads/${threadId}?accountId=${account.id}`,
          { cache: "no-store" }
        );
        const payload = await response.json();
        if (payload.success) {
          setMessages(payload.data.messages);
          writeCache(messagesKey(threadId), payload.data.messages);
        }
      } catch {
        // Keep whatever is on screen rather than blanking a read thread.
      } finally {
        setThreadLoading(false);
      }
    },
    [account.id]
  );

  useEffect(() => {
    if (!activeId) return;
    // `openThread` already painted any cached messages synchronously from the
    // click, so this effect only refreshes and polls, both on a later task.
    const first = window.setTimeout(() => void loadMessages(activeId), 0);
    const timer = window.setInterval(() => void loadMessages(activeId), POLL_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [activeId, loadMessages]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages]);

  function openThread(id: string) {
    setActiveId(id);
    setSendError(null);
    const cached = readCache<ThreadMessage[]>(messagesKey(id), CACHE_MAX_AGE_MS);
    setMessages(cached.data ?? []);
    setThreadLoading(!cached.data);
  }

  async function send() {
    const text = draft.trim();
    if (!text || !active?.contact.id || sending) return;
    setSending(true);
    setSendError(null);

    const optimistic: ThreadMessage = {
      id: `pending-${Date.now()}`,
      text,
      fromMe: true,
      fromUsername: null,
      at: new Date().toISOString(),
    };
    setMessages((previous) => [...previous, optimistic]);
    setDraft("");

    try {
      const response = await fetch("/api/inbox/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: account.id,
          recipientId: active.contact.id,
          text,
        }),
      });
      const payload = await response.json();
      if (payload.success) {
        await loadMessages(active.id);
        void loadThreads(true);
      } else {
        setMessages((previous) => previous.filter((m) => m.id !== optimistic.id));
        setDraft(text);
        setSendError(payload.error ?? "Could not send the message");
      }
    } catch {
      setMessages((previous) => previous.filter((m) => m.id !== optimistic.id));
      setDraft(text);
      setSendError("Could not send the message");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Inbox</h1>
        <p className="mt-1 text-sm text-muted">
          {account.label} — one account at a time, because each platform gives you
          a different window to reply in.
        </p>
      </div>

      <PlatformPills
        groups={groups}
        activeId={account.id}
        hrefFor={(a) => `/inbox/${a.id}`}
      />

      <div className="grid h-[calc(100dvh-16rem)] grid-cols-1 overflow-hidden rounded border border-border sm:grid-cols-[300px_1fr]">
        <div
          className={`min-h-0 flex-col border-b border-border sm:flex sm:border-b-0 sm:border-r ${
            active ? "hidden" : "flex"
          }`}
        >
          <div className="shrink-0 border-b border-border px-4 py-3 text-sm font-semibold text-foreground">
            Conversations
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {listLoading ? (
              <p className="px-4 py-6 text-sm text-muted">Loading…</p>
            ) : listError ? (
              <p className="px-4 py-6 text-sm text-error">{listError}</p>
            ) : threads.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted">No conversations yet.</p>
            ) : (
              threads.map((thread) => (
                <button
                  key={thread.id}
                  type="button"
                  onClick={() => openThread(thread.id)}
                  className={`block w-full border-b border-border px-4 py-3 text-left ${
                    thread.id === activeId ? "bg-surface-hover" : "hover:bg-surface-hover"
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {thread.contact.username ?? "unknown"}
                    </span>
                    <span className="shrink-0 text-[11px] text-zinc-500">
                      {formatTime(thread.updatedAt)}
                    </span>
                  </div>
                  {thread.lastMessage && (
                    <p className="mt-0.5 truncate text-xs text-muted">
                      {thread.lastMessage.fromMe ? "You: " : ""}
                      {thread.lastMessage.text || "(no text)"}
                    </p>
                  )}
                </button>
              ))
            )}
          </div>
        </div>

        <div className={`min-h-0 flex-col ${active ? "flex" : "hidden sm:flex"}`}>
          {!active ? (
            <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted">
              Select a conversation to read and reply.
            </div>
          ) : (
            <>
              <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3 text-sm font-semibold text-foreground">
                <button
                  type="button"
                  onClick={() => setActiveId(null)}
                  className="-ml-1 rounded px-2 py-1 text-muted hover:text-foreground sm:hidden"
                  aria-label="Back to conversations"
                >
                  Back
                </button>
                <span className="truncate">{active.contact.username ?? "unknown"}</span>
              </div>

              <div
                ref={scrollRef}
                className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4"
              >
                {threadLoading && messages.length === 0 ? (
                  <p className="text-sm text-muted">Loading…</p>
                ) : messages.length === 0 ? (
                  <p className="text-sm text-muted">No messages.</p>
                ) : (
                  messages.map((message) => (
                    <div
                      key={message.id}
                      className={`flex ${message.fromMe ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
                          message.fromMe
                            ? "bg-accent text-white"
                            : "border border-border bg-surface text-foreground"
                        }`}
                      >
                        <p className="whitespace-pre-wrap break-words">{message.text}</p>
                        <p
                          className={`mt-1 text-[10px] ${
                            message.fromMe ? "text-white/70" : "text-zinc-500"
                          }`}
                        >
                          {formatTime(message.at)}
                        </p>
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div className="shrink-0 border-t border-border p-3">
                {sendError && <p className="mb-2 text-xs text-error">{sendError}</p>}
                {canReply ? (
                  <div className="flex items-end gap-2">
                    <textarea
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          void send();
                        }
                      }}
                      rows={1}
                      placeholder="Write a reply…  (Enter to send, Shift+Enter for a new line)"
                      className="max-h-32 min-h-[40px] flex-1 resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => void send()}
                      disabled={sending || !draft.trim()}
                      className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                    >
                      {sending ? "Sending…" : "Send"}
                    </button>
                  </div>
                ) : (
                  <p className="text-xs text-muted">
                    This platform lets you read the conversation but not start a
                    reply from here.
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <p className="text-xs text-muted">
        Looking for what your campaigns sent?{" "}
        <Link href="/activity" className="text-accent hover:underline">
          Activity
        </Link>{" "}
        covers every account at once.
      </p>
    </div>
  );
}
