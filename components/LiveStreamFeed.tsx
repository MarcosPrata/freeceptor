"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type LiveStreamFrame = {
  id: string;
  at: string;
  event: string;
  data: string;
};

export type LiveStream = {
  requestId: string;
  logId?: string;
  serverName: string;
  apiName: string;
  method: string;
  path: string;
  status: number;
  openedAt: string;
  closedAt?: string;
  error?: string;
  frames: LiveStreamFrame[];
  frameCount: number;
  byteCount: number;
  mock?: boolean;
  source?: "mock" | "url" | "client";
  overrodeApiProxy?: boolean;
  fakeEventsEnabled?: boolean;
  fakeEventsIntervalMs?: number;
};

export function isHeartbeatFrame(frame: LiveStreamFrame): boolean {
  return frame.event === "heartbeat" || frame.data === "heartbeat";
}

export function formatStreamDuration(openedAt: string, closedAt?: string, now = Date.now()): string {
  const start = new Date(openedAt).getTime();
  const end = closedAt ? new Date(closedAt).getTime() : now;
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${String(rest).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function LiveStatusPill({ live }: { live: boolean }) {
  if (live) {
    return (
      <span className="inline-flex min-w-12 items-center justify-center gap-1 rounded-full bg-emerald-600 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wide text-white dark:bg-emerald-500 dark:text-zinc-950">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/80 opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-white" />
        </span>
        Ao vivo
      </span>
    );
  }
  return (
    <span className="inline-flex min-w-12 items-center justify-center rounded-full bg-cyan-700 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wide text-white dark:bg-cyan-500 dark:text-zinc-950">
      SSE
    </span>
  );
}

export function StreamSourcePill({
  source,
  override = false,
}: {
  source?: "mock" | "url" | "client";
  override?: boolean;
}) {
  const mode = source;
  if (!mode) return null;
  const variant = override ? "filled" : "outline";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded px-1 py-px font-sans text-[8px] font-semibold uppercase tracking-wide",
        variant === "filled" &&
          mode === "mock" &&
          "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
        variant === "filled" &&
          mode === "url" &&
          "bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-300",
        variant === "filled" &&
          mode === "client" &&
          "bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300",
        variant === "outline" &&
          mode === "mock" &&
          "border border-amber-400/70 bg-transparent text-amber-700 dark:border-amber-500/50 dark:text-amber-300",
        variant === "outline" &&
          mode === "url" &&
          "border border-violet-400/70 bg-transparent text-violet-700 dark:border-violet-500/50 dark:text-violet-300",
        variant === "outline" &&
          mode === "client" &&
          "border border-blue-400/70 bg-transparent text-blue-700 dark:border-blue-500/50 dark:text-blue-300",
      )}
      title={
        override
          ? mode === "mock"
            ? "Mock (sobrescreve o proxy da API)"
            : mode === "url"
              ? "Proxy URL (sobrescreve o proxy da API)"
              : "Proxy client (sobrescreve o proxy da API)"
          : mode === "client"
            ? "Proxy client (da API)"
            : mode === "url"
              ? "Proxy URL (da API)"
              : "Mock (comportamento padrão)"
      }
    >
      {mode}
    </span>
  );
}

function prettyData(data: string): string {
  const trimmed = data.trim();
  if (!trimmed) return "";
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return data;
  }
}

const FAKE_INTERVALS_MS = [3_000, 5_000, 10_000, 15_000];

async function postFakeEvents(
  requestId: string,
  body: { enabled?: boolean; intervalMs?: number; emitOnce?: boolean },
): Promise<boolean> {
  const res = await fetch("/api/streams/fake", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, ...body }),
  });
  return res.ok;
}

export function LiveStreamFeed({
  stream,
  compact = false,
}: {
  stream: LiveStream;
  compact?: boolean;
}) {
  const [showHeartbeats, setShowHeartbeats] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const live = !stream.closedAt;
  const intervalMs = stream.fakeEventsIntervalMs ?? 5_000;
  const intervalOptions = useMemo(() => {
    if (FAKE_INTERVALS_MS.includes(intervalMs)) return FAKE_INTERVALS_MS;
    return [...FAKE_INTERVALS_MS, intervalMs].sort((a, b) => a - b);
  }, [intervalMs]);

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);

  const visibleFrames = useMemo(
    () =>
      showHeartbeats
        ? stream.frames
        : stream.frames.filter((frame) => !isHeartbeatFrame(frame)),
    [stream.frames, showHeartbeats],
  );

  const hiddenHeartbeats = stream.frames.length - visibleFrames.length;

  async function runFake(body: { enabled?: boolean; intervalMs?: number; emitOnce?: boolean }) {
    if (busy) return;
    setBusy(true);
    try {
      await postFakeEvents(stream.requestId, body);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [visibleFrames.length]);

  return (
    <div className={cn("rounded border border-cyan-200/80 bg-zinc-950 text-zinc-100 dark:border-cyan-900/60", compact && "mt-2")}>
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-2.5 py-1.5 text-[10px] text-zinc-400">
        <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
          <span>{live ? "A receber frames" : "Stream encerrado"}</span>
          <StreamSourcePill
            source={stream.source ?? (stream.mock ? "mock" : undefined)}
            override={Boolean(stream.overrodeApiProxy)}
          />
          <span>
            {formatStreamDuration(stream.openedAt, stream.closedAt, now)}
            {" · "}
            {stream.frameCount} evento{stream.frameCount === 1 ? "" : "s"}
          </span>
        </span>
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-zinc-500 hover:text-zinc-300">
          <input
            type="checkbox"
            className="h-3 w-3 accent-cyan-500"
            checked={showHeartbeats}
            onChange={(e) => setShowHeartbeats(e.target.checked)}
          />
          Heartbeats
          {hiddenHeartbeats > 0 ? ` (${hiddenHeartbeats})` : ""}
        </label>
      </div>
      {stream.mock && live ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-2.5 py-1.5 text-[10px] text-zinc-400">
          <label className="inline-flex cursor-pointer items-center gap-1.5 hover:text-zinc-200">
            <input
              type="checkbox"
              className="h-3 w-3 accent-cyan-500"
              checked={Boolean(stream.fakeEventsEnabled)}
              disabled={busy}
              onChange={(e) => {
                void runFake({
                  enabled: e.target.checked,
                  intervalMs,
                });
              }}
            />
            Body do mock
          </label>
          <span className="text-zinc-600">a cada</span>
          <select
            className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-200"
            value={intervalMs}
            disabled={busy}
            onChange={(e) => {
              const next = Number(e.target.value);
              void runFake({
                enabled: Boolean(stream.fakeEventsEnabled),
                intervalMs: next,
              });
            }}
          >
            {intervalOptions.map((ms) => (
              <option key={ms} value={ms}>
                {ms / 1000}s
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void runFake({ emitOnce: true });
            }}
            className="rounded border border-cyan-800 bg-cyan-950 px-2 py-0.5 font-medium text-cyan-200 hover:bg-cyan-900 disabled:opacity-50"
          >
            Emitir agora
          </button>
          <span className="text-zinc-600">
            envia o body da rota · o Bruno recebe o mesmo frame
          </span>
        </div>
      ) : null}
      <div
        ref={scrollerRef}
        className="max-h-64 overflow-auto font-mono text-[11px] leading-relaxed"
      >
        {visibleFrames.length === 0 ? (
          <div className="px-2.5 py-4 text-zinc-500">
            {live
              ? stream.mock
                ? "À espera do primeiro evento. Liga Body do mock para emitir o JSON da rota."
                : "À espera do primeiro evento (heartbeats estão escondidos)…"
              : "Nenhum evento gravado neste stream."}
          </div>
        ) : (
          visibleFrames.map((frame) => {
            const heartbeat = isHeartbeatFrame(frame);
            return (
              <div
                key={frame.id}
                className={cn(
                  "border-b border-zinc-900 px-2.5 py-1.5 last:border-b-0",
                  heartbeat && "opacity-50",
                )}
              >
                <div className="mb-0.5 flex items-center gap-2 text-[10px]">
                  <span className="text-zinc-500">
                    {new Date(frame.at).toLocaleTimeString()}
                  </span>
                  <span
                    className={cn(
                      "rounded px-1 py-px font-semibold uppercase tracking-wide",
                      heartbeat
                        ? "bg-zinc-800 text-zinc-400"
                        : "bg-cyan-950 text-cyan-300",
                    )}
                  >
                    {frame.event}
                  </span>
                </div>
                {frame.data ? (
                  <pre className="whitespace-pre-wrap break-all text-zinc-200">
                    {prettyData(frame.data)}
                  </pre>
                ) : null}
              </div>
            );
          })
        )}
      </div>
      {stream.error ? (
        <div className="border-t border-red-900/60 px-2.5 py-1.5 text-[10px] text-red-300">
          {stream.error}
        </div>
      ) : null}
    </div>
  );
}
