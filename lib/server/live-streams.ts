/**
 * In-memory registry of long-lived HTTP streams (SSE) flowing through the
 * proxy. Frames are not written to Mongo: heartbeats would drown the log.
 * The UI watches them over `/api/events` (`stream_open` / `stream_frame` /
 * `stream_close`).
 */

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
  clientIp?: string;
  clientGeo?: string;
};

export type LiveStreamEvent =
  | { type: "stream_open"; stream: LiveStream }
  | { type: "stream_update"; requestId: string; apiName: string; stream: LiveStream }
  | { type: "stream_frame"; requestId: string; apiName: string; frame: LiveStreamFrame }
  | { type: "stream_close"; requestId: string; apiName: string; closedAt: string; frameCount: number; error?: string };

type LiveStreamListener = (event: LiveStreamEvent) => void;

type StreamRecord = LiveStream & {
  parser: SseParser;
};

const MAX_FRAMES = 200;
const CLOSED_TTL_MS = 30 * 60 * 1000;

class SseParser {
  private buffer = "";

  push(chunk: Buffer): LiveStreamFrame[] {
    this.buffer += chunk.toString("utf8");
    const frames: LiveStreamFrame[] = [];

    while (true) {
      const split = splitSseBlock(this.buffer);
      if (!split) break;
      this.buffer = split.rest;
      const parsed = parseSseBlock(split.raw);
      if (parsed) frames.push(parsed);
    }

    return frames;
  }
}

function splitSseBlock(text: string): { raw: string; rest: string } | null {
  const crlf = text.indexOf("\r\n\r\n");
  const lf = text.indexOf("\n\n");
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) {
    return { raw: text.slice(0, crlf), rest: text.slice(crlf + 4) };
  }
  if (lf >= 0) {
    return { raw: text.slice(0, lf), rest: text.slice(lf + 2) };
  }
  return null;
}

function parseSseBlock(raw: string): LiveStreamFrame | null {
  let event = "message";
  const dataLines: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice(6).trim() || "message";
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0 && event === "message") return null;

  return {
    id: `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    event,
    data: dataLines.join("\n"),
  };
}

class LiveStreamRegistry {
  private streams = new Map<string, StreamRecord>();
  private listeners = new Set<{ serverName: string; listener: LiveStreamListener }>();

  ensure(requestId: string): StreamRecord {
    let record = this.streams.get(requestId);
    if (record) return record;
    record = {
      requestId,
      serverName: "",
      apiName: "",
      method: "GET",
      path: "",
      status: 200,
      openedAt: new Date().toISOString(),
      frames: [],
      frameCount: 0,
      byteCount: 0,
      parser: new SseParser(),
    };
    this.streams.set(requestId, record);
    return record;
  }

  bind(
    requestId: string,
    meta: {
      logId: string;
      serverName: string;
      apiName: string;
      method: string;
      path: string;
      status: number;
      mock?: boolean;
      source?: "mock" | "url" | "client";
      overrodeApiProxy?: boolean;
      fakeEventsEnabled?: boolean;
      fakeEventsIntervalMs?: number;
      clientIp?: string;
      clientGeo?: string;
    },
  ): LiveStream {
    const record = this.ensure(requestId);
    record.logId = meta.logId;
    record.serverName = meta.serverName;
    record.apiName = meta.apiName;
    record.method = meta.method;
    record.path = meta.path;
    record.status = meta.status;
    if (meta.mock !== undefined) record.mock = meta.mock;
    if (meta.source !== undefined) record.source = meta.source;
    if (meta.overrodeApiProxy !== undefined) {
      record.overrodeApiProxy = meta.overrodeApiProxy;
    }
    if (meta.fakeEventsEnabled !== undefined) {
      record.fakeEventsEnabled = meta.fakeEventsEnabled;
    }
    if (meta.fakeEventsIntervalMs !== undefined) {
      record.fakeEventsIntervalMs = meta.fakeEventsIntervalMs;
    }
    if (meta.clientIp !== undefined) record.clientIp = meta.clientIp;
    if (meta.clientGeo !== undefined) record.clientGeo = meta.clientGeo;
    this.emit(record.serverName, { type: "stream_open", stream: toPublic(record) });
    return toPublic(record);
  }

  get(requestId: string): LiveStream | undefined {
    const record = this.streams.get(requestId);
    return record ? toPublic(record) : undefined;
  }

  updateMeta(
    requestId: string,
    patch: {
      mock?: boolean;
      fakeEventsEnabled?: boolean;
      fakeEventsIntervalMs?: number;
      clientIp?: string;
      clientGeo?: string;
    },
  ): LiveStream | undefined {
    const record = this.streams.get(requestId);
    if (!record) return undefined;
    if (patch.mock !== undefined) record.mock = patch.mock;
    if (patch.fakeEventsEnabled !== undefined) {
      record.fakeEventsEnabled = patch.fakeEventsEnabled;
    }
    if (patch.fakeEventsIntervalMs !== undefined) {
      record.fakeEventsIntervalMs = patch.fakeEventsIntervalMs;
    }
    if (patch.clientIp !== undefined) record.clientIp = patch.clientIp;
    if (patch.clientGeo !== undefined) record.clientGeo = patch.clientGeo;
    const stream = toPublic(record);
    if (record.serverName && record.apiName) {
      this.emit(record.serverName, {
        type: "stream_update",
        requestId,
        apiName: record.apiName,
        stream,
      });
    }
    return stream;
  }

  appendChunk(requestId: string, chunk: Buffer): void {
    if (chunk.byteLength === 0) return;
    const record = this.ensure(requestId);
    record.byteCount += chunk.byteLength;
    const parsed = record.parser.push(chunk);
    for (const frame of parsed) {
      record.frameCount += 1;
      record.frames.push(frame);
      if (record.frames.length > MAX_FRAMES) {
        record.frames.splice(0, record.frames.length - MAX_FRAMES);
      }
      if (record.apiName) {
        this.emit(record.serverName, {
          type: "stream_frame",
          requestId,
          apiName: record.apiName,
          frame,
        });
      }
    }
  }

  close(requestId: string, error?: string): void {
    const record = this.streams.get(requestId);
    if (!record || record.closedAt) return;
    record.closedAt = new Date().toISOString();
    record.error = error;
    if (record.apiName) {
      this.emit(record.serverName, {
        type: "stream_close",
        requestId,
        apiName: record.apiName,
        closedAt: record.closedAt,
        frameCount: record.frameCount,
        error,
      });
    } else if (!record.logId) {
      this.streams.delete(requestId);
      return;
    }
    setTimeout(() => {
      const current = this.streams.get(requestId);
      if (current?.closedAt) this.streams.delete(requestId);
    }, CLOSED_TTL_MS);
  }

  list(serverName: string, apiName: string): LiveStream[] {
    const api = apiName.trim().toLowerCase();
    const result: LiveStream[] = [];
    for (const record of this.streams.values()) {
      if (record.serverName !== serverName) continue;
      if (record.apiName.trim().toLowerCase() !== api) continue;
      result.push(toPublic(record));
    }
    return result.sort((a, b) => {
      const aOpen = a.closedAt ? 1 : 0;
      const bOpen = b.closedAt ? 1 : 0;
      if (aOpen !== bOpen) return aOpen - bOpen;
      return b.openedAt.localeCompare(a.openedAt);
    });
  }

  subscribe(serverName: string, listener: LiveStreamListener): () => void {
    const entry = { serverName, listener };
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  private emit(serverName: string, event: LiveStreamEvent): void {
    if (!serverName) return;
    for (const entry of this.listeners) {
      if (entry.serverName !== serverName) continue;
      try {
        entry.listener(event);
      } catch {
        // ignore
      }
    }
  }
}

function toPublic(record: StreamRecord): LiveStream {
  const { parser: _parser, ...rest } = record;
  return {
    ...rest,
    frames: rest.frames.slice(),
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __freeceptorLiveStreams: LiveStreamRegistry | undefined;
}

const existing = globalThis.__freeceptorLiveStreams;
if (existing) {
  Object.setPrototypeOf(existing, LiveStreamRegistry.prototype);
  globalThis.__freeceptorLiveStreams = existing;
} else {
  globalThis.__freeceptorLiveStreams = new LiveStreamRegistry();
}

const registry = globalThis.__freeceptorLiveStreams;

export function bindLiveStream(
  requestId: string,
  meta: {
    logId: string;
    serverName: string;
    apiName: string;
    method: string;
    path: string;
    status: number;
    mock?: boolean;
    source?: "mock" | "url" | "client";
    overrodeApiProxy?: boolean;
    fakeEventsEnabled?: boolean;
    fakeEventsIntervalMs?: number;
    clientIp?: string;
    clientGeo?: string;
  },
): LiveStream {
  return registry.bind(requestId, meta);
}

export function getLiveStream(requestId: string): LiveStream | undefined {
  return registry.get(requestId);
}

export function updateLiveStreamMeta(
  requestId: string,
  patch: {
    mock?: boolean;
    fakeEventsEnabled?: boolean;
    fakeEventsIntervalMs?: number;
    clientIp?: string;
    clientGeo?: string;
  },
): LiveStream | undefined {
  return registry.updateMeta(requestId, patch);
}

export function appendLiveStreamChunk(requestId: string, chunk: Buffer): void {
  registry.appendChunk(requestId, chunk);
}

export function closeLiveStream(requestId: string, error?: string): void {
  registry.close(requestId, error);
}

export function listLiveStreams(serverName: string, apiName: string): LiveStream[] {
  return registry.list(serverName, apiName);
}

export function subscribeToLiveStreams(
  serverName: string,
  listener: LiveStreamListener,
): () => void {
  return registry.subscribe(serverName, listener);
}

export function tapReadableStream(
  source: ReadableStream<Uint8Array>,
  requestId: string,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          closeLiveStream(requestId);
          controller.close();
          return;
        }
        if (value) {
          appendLiveStreamChunk(requestId, Buffer.from(value));
          controller.enqueue(value);
        }
      } catch (err) {
        closeLiveStream(
          requestId,
          err instanceof Error ? err.message : "Stream error",
        );
        controller.error(err);
      }
    },
    cancel(reason) {
      closeLiveStream(
        requestId,
        reason instanceof Error ? reason.message : undefined,
      );
      return reader.cancel(reason);
    },
  });
}
