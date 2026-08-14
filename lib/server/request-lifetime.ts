import type { IncomingMessage, ServerResponse } from "node:http";

export const LIFETIME_HEADER = "x-freeceptor-lifetime";

type RequestLifetime = {
  closed: boolean;
  onClose: Set<() => void>;
};

const lifetimes = new Map<string, RequestLifetime>();

export function beginNodeRequest(req: IncomingMessage, res: ServerResponse): void {
  const id = `lt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const lifetime: RequestLifetime = { closed: false, onClose: new Set() };
  lifetimes.set(id, lifetime);
  req.headers[LIFETIME_HEADER] = id;

  const onDrop = () => {
    if (lifetime.closed) return;
    lifetime.closed = true;
    for (const cb of lifetime.onClose) {
      try {
        cb();
      } catch {
        // ignore
      }
    }
    lifetime.onClose.clear();
    lifetimes.delete(id);
  };

  req.on("close", onDrop);
  res.on("close", onDrop);
}

/** Runs when the Node HTTP request drops (client hung up). */
export function onRequestClosed(cb: () => void, request?: Request): () => void {
  const id = request?.headers.get(LIFETIME_HEADER)?.trim();
  const lifetime = id ? lifetimes.get(id) : undefined;
  if (!lifetime) return () => undefined;
  if (lifetime.closed) {
    cb();
    return () => undefined;
  }
  lifetime.onClose.add(cb);
  return () => {
    lifetime.onClose.delete(cb);
  };
}
