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
  responseStatus: number;
  responseBody: unknown;
  responseHeaders: Record<string, string>;
};

let counter = 1;
const logs: ApiRequestLog[] = [];

type ChangeListener = (payload: {
  logs: ApiRequestLog[];
  routes: ApiRouteStat[];
}) => void;

const listeners = new Set<ChangeListener>();

function normalizePath(path: string): string {
  if (!path) return "/";
  let result = path.trim();
  if (!result.startsWith("/")) {
    result = `/${result}`;
  }
  // remove barra final, exceto se for apenas "/"
  if (result.length > 1 && result.endsWith("/")) {
    result = result.slice(0, -1);
  }
  return result;
}

export function addRequestLog(entry: Omit<ApiRequestLog, "id" | "timestamp">) {
  const log: ApiRequestLog = {
    id: counter++,
    timestamp: new Date().toISOString(),
    ...entry,
    path: normalizePath(entry.path),
  };
  logs.unshift(log);
  // limita tamanho para não crescer infinito
  if (logs.length > 200) {
    logs.length = 200;
  }
  notifyChange();
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

export type ApiRouteConfig = {
  method: string;
  path: string;
  status: number;
  body: unknown;
  headers: Record<string, string>;
};

const routeConfigs = new Map<string, ApiRouteConfig>();

function configKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

export function setRouteConfig(config: ApiRouteConfig): ApiRouteConfig {
  const normalizedPath = normalizePath(config.path);
  const key = configKey(config.method, normalizedPath);
  const normalized: ApiRouteConfig = {
    ...config,
    method: config.method.toUpperCase(),
    path: normalizedPath,
    status: config.status || 200,
    headers: config.headers ?? {},
  };
  routeConfigs.set(key, normalized);
  notifyChange();
  return normalized;
}

export function getRouteConfigFor(
  method: string,
  path: string,
): ApiRouteConfig | undefined {
  const key = configKey(method, normalizePath(path));
  return routeConfigs.get(key);
}

export function getAllRouteConfigs(): ApiRouteConfig[] {
  return Array.from(routeConfigs.values());
}

export function getSnapshot() {
  return {
    logs: getRequestLogs(),
    routes: getRouteStats(),
  };
}

export function subscribeToChanges(listener: ChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyChange() {
  if (listeners.size === 0) return;
  const snapshot = getSnapshot();
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch {
      // ignore listener errors
    }
  }
}


