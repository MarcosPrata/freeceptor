/**
 * Logger em memória para requests em /api.
 * Em produção você pode trocar por banco, Redis, etc.
 */

export type ApiRequestLog = {
  id: number;
  timestamp: string;
  method: string;
  path: string;
  slug: string[];
  body: unknown;
  headers: Record<string, string>;
};

let counter = 1;
const logs: ApiRequestLog[] = [];

export function addRequestLog(entry: Omit<ApiRequestLog, "id" | "timestamp">) {
  const log: ApiRequestLog = {
    id: counter++,
    timestamp: new Date().toISOString(),
    ...entry,
  };
  logs.unshift(log);
  // limita tamanho para não crescer infinito
  if (logs.length > 200) {
    logs.length = 200;
  }
}

export function getRequestLogs(): ApiRequestLog[] {
  return logs;
}

export type ApiRouteStat = {
  id: string;
  method: string;
  path: string;
  count: number;
  firstTimestamp: string;
  lastTimestamp: string;
};

export function getRouteStats(): ApiRouteStat[] {
  const map = new Map<string, ApiRouteStat>();

  for (const log of logs) {
    const pathFromSlug = log.slug.length ? `/${log.slug.join("/")}` : "/";
    const key = `${log.method} ${pathFromSlug}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        id: key,
        method: log.method,
        path: pathFromSlug,
        count: 1,
        firstTimestamp: log.timestamp,
        lastTimestamp: log.timestamp,
      });
    } else {
      existing.count += 1;
      existing.lastTimestamp = log.timestamp;
    }
  }

  return Array.from(map.values()).sort((a, b) =>
    a.path === b.path
      ? a.method.localeCompare(b.method)
      : a.path.localeCompare(b.path),
  );
}

