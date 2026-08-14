import { getRouteConfigFor } from "./request-log";
import {
  appendLiveStreamChunk,
  closeLiveStream,
  updateLiveStreamMeta,
} from "./live-streams";

export const DEFAULT_FAKE_INTERVAL_MS = 5_000;
const MIN_FAKE_INTERVAL_MS = 2_000;
const MAX_FAKE_INTERVAL_MS = 60_000;
const HEARTBEAT_MS = 15_000;

type MockPusher = {
  enqueue: (bytes: Uint8Array) => boolean;
  closeController: () => void;
  fakeTimer?: ReturnType<typeof setInterval>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  fakeEnabled: boolean;
  fakeIntervalMs: number;
  serverName: string;
  apiName: string;
  method: string;
  path: string;
};

declare global {
  // eslint-disable-next-line no-var
  var __freeceptorMockSsePushers: Map<string, MockPusher> | undefined;
}

const pushers =
  globalThis.__freeceptorMockSsePushers ??
  (globalThis.__freeceptorMockSsePushers = new Map<string, MockPusher>());

const encoder = new TextEncoder();

export function clampFakeIntervalMs(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_FAKE_INTERVAL_MS;
  return Math.min(MAX_FAKE_INTERVAL_MS, Math.max(MIN_FAKE_INTERVAL_MS, Math.round(ms)));
}

export function parseFakeSseQuery(
  query: Record<string, string | string[]>,
): { enabled: boolean; intervalMs: number } {
  const raw = (key: string): string | undefined => {
    const value = query[key];
    if (Array.isArray(value)) return value[0];
    return value;
  };
  const fake = (raw("fake") ?? "").toLowerCase();
  const intervalRaw = raw("fakeInterval") ?? raw("interval");
  const intervalSec = intervalRaw ? Number(intervalRaw) : NaN;
  const intervalMs = Number.isFinite(intervalSec) && intervalSec > 0
    ? clampFakeIntervalMs(intervalSec * 1000)
    : DEFAULT_FAKE_INTERVAL_MS;
  const enabled =
    fake === "1" ||
    fake === "true" ||
    fake === "yes" ||
    (intervalRaw !== undefined && Number.isFinite(intervalSec));
  return { enabled, intervalMs };
}

export function hasMockSsePusher(requestId: string): boolean {
  return pushers.has(requestId);
}

export function abortMockSseStream(requestId: string): void {
  const pusher = pushers.get(requestId);
  if (!pusher) {
    closeLiveStream(requestId);
    return;
  }
  stopFakeTimer(pusher);
  if (pusher.heartbeatTimer) {
    clearInterval(pusher.heartbeatTimer);
    pusher.heartbeatTimer = undefined;
  }
  pushers.delete(requestId);
  pusher.closeController();
  closeLiveStream(requestId);
}

export function encodeSseFrame(event: string, data: string): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${data}\n\n`);
}

function stringifyData(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function sseFrameFromMockBody(body: unknown): { event: string; data: string } {
  if (body == null) {
    return { event: "message", data: "" };
  }
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed) return { event: "message", data: "" };
    try {
      return sseFrameFromMockBody(JSON.parse(trimmed));
    } catch {
      return { event: "message", data: body };
    }
  }
  if (typeof body === "object" && !Array.isArray(body)) {
    const rec = body as Record<string, unknown>;
    const named =
      (typeof rec.event === "string" && rec.event.trim()) ||
      (typeof rec.type === "string" && rec.type.trim()) ||
      "";
    if (named && "data" in rec) {
      return { event: named, data: stringifyData(rec.data) };
    }
    if (named) {
      return { event: named, data: stringifyData(body) };
    }
    return { event: "message", data: stringifyData(body) };
  }
  return { event: "message", data: stringifyData(body) };
}

function enqueueFrame(pusher: MockPusher, requestId: string, bytes: Uint8Array): boolean {
  appendLiveStreamChunk(requestId, Buffer.from(bytes));
  return pusher.enqueue(bytes);
}

function stopFakeTimer(pusher: MockPusher): void {
  if (pusher.fakeTimer) {
    clearInterval(pusher.fakeTimer);
    pusher.fakeTimer = undefined;
  }
}

function startFakeTimer(requestId: string, pusher: MockPusher): void {
  stopFakeTimer(pusher);
  pusher.fakeTimer = setInterval(() => {
    void emitFakeSseEvent(requestId);
  }, pusher.fakeIntervalMs);
}

export async function emitFakeSseEvent(requestId: string): Promise<boolean> {
  const pusher = pushers.get(requestId);
  if (!pusher) return false;
  const config = await getRouteConfigFor(
    pusher.serverName,
    pusher.apiName,
    pusher.method,
    pusher.path,
  );
  const frame = sseFrameFromMockBody(config?.body ?? { status: "ok" });
  return enqueueFrame(pusher, requestId, encodeSseFrame(frame.event, frame.data));
}

export function setMockFakeEvents(
  requestId: string,
  opts: { enabled: boolean; intervalMs?: number; emitNow?: boolean },
): { enabled: boolean; intervalMs: number } | undefined {
  const pusher = pushers.get(requestId);
  if (!pusher) return undefined;

  pusher.fakeIntervalMs = clampFakeIntervalMs(
    opts.intervalMs ?? pusher.fakeIntervalMs,
  );
  pusher.fakeEnabled = opts.enabled;

  if (!opts.enabled) {
    stopFakeTimer(pusher);
  } else {
    startFakeTimer(requestId, pusher);
    if (opts.emitNow) {
      void emitFakeSseEvent(requestId);
    }
  }

  updateLiveStreamMeta(requestId, {
    fakeEventsEnabled: pusher.fakeEnabled,
    fakeEventsIntervalMs: pusher.fakeIntervalMs,
  });

  return { enabled: pusher.fakeEnabled, intervalMs: pusher.fakeIntervalMs };
}

export function createMockSseStream(
  requestId: string,
  opts: {
    fakeEnabled?: boolean;
    fakeIntervalMs?: number;
    serverName: string;
    apiName: string;
    method: string;
    path: string;
  },
): ReadableStream<Uint8Array> {
  let closed = false;
  const fakeIntervalMs = clampFakeIntervalMs(
    opts.fakeIntervalMs ?? DEFAULT_FAKE_INTERVAL_MS,
  );

  const beat = (): Uint8Array => encodeSseFrame("heartbeat", "heartbeat");

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const pusher: MockPusher = {
        fakeEnabled: false,
        fakeIntervalMs,
        serverName: opts.serverName,
        apiName: opts.apiName,
        method: opts.method,
        path: opts.path,
        enqueue: (bytes) => {
          if (closed) return false;
          try {
            controller.enqueue(bytes);
            return true;
          } catch {
            closed = true;
            return false;
          }
        },
        closeController: () => {
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed
          }
        },
      };
      pushers.set(requestId, pusher);

      enqueueFrame(pusher, requestId, beat());
      pusher.heartbeatTimer = setInterval(() => {
        if (closed) return;
        if (!enqueueFrame(pusher, requestId, beat())) {
          abortMockSseStream(requestId);
        }
      }, HEARTBEAT_MS);

      if (opts.fakeEnabled) {
        setMockFakeEvents(requestId, {
          enabled: true,
          intervalMs: fakeIntervalMs,
          emitNow: true,
        });
      }
    },
    cancel() {
      abortMockSseStream(requestId);
    },
  });
}
