import { getDb } from "@/lib/server/mongo";

export type ApiRequestLog = {
  id: number;
  timestamp: string;
  method: string;
  path: string;
  slug: string[];
  queryParams: Record<string, string | string[]>;
  proxyTargetUrl?: string;
  body: unknown;
  headers: Record<string, string>;
  responseStatus: number;
  responseBody: unknown;
  responseHeaders: Record<string, string>;
};

export type ApiRouteStat = {
  id: string;
  method: string;
  path: string;
  count: number;
  firstTimestamp: string;
  lastTimestamp: string;
};

export type ApiRouteConfig = {
  method: string;
  path: string;
  status: number;
  body: unknown;
  headers: Record<string, string>;
  proxyMode?: boolean;
  proxyUrl?: string;
};

type LogDoc = {
  _id: string;
  serverName: string;
} & Omit<ApiRequestLog, "id">;

type RouteConfigDoc = {
  _id: string;
  serverName: string;
} & ApiRouteConfig;

type ChangeListener = (payload: {
  logs: ApiRequestLog[];
  routes: ApiRouteStat[];
}) => void;

type ListenerEntry = {
  serverName: string;
  listener: ChangeListener;
};

const listeners = new Set<ListenerEntry>();

async function logsCollection() {
  const db = await getDb();
  return db.collection<LogDoc>("request_logs");
}

async function routeConfigsCollection() {
  const db = await getDb();
  return db.collection<RouteConfigDoc>("route_configs");
}

function normalizePath(path: string): string {
  if (!path) return "/";
  let result = path.trim();
  if (!result.startsWith("/")) {
    result = `/${result}`;
  }
  if (result.length > 1 && result.endsWith("/")) {
    result = result.slice(0, -1);
  }
  return result;
}

function configKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function parseLogIndexFromId(id: string): number {
  const [head] = id.split(":");
  const value = Number(head);
  return Number.isNaN(value) ? 0 : value;
}

function mapConfig(config: ApiRouteConfig | RouteConfigDoc): ApiRouteConfig {
  return {
    ...config,
    method: config.method.toUpperCase(),
    path: normalizePath(config.path),
    status: config.status || 200,
    headers: config.headers ?? {},
    proxyMode: Boolean(config.proxyMode),
    proxyUrl: config.proxyUrl?.trim() ?? "",
  };
}

export async function addRequestLog(
  serverName: string,
  entry: Omit<ApiRequestLog, "id" | "timestamp">,
): Promise<void> {
  const collection = await logsCollection();
  const now = new Date();
  const normalizedPath = normalizePath(entry.path);
  const normalizedTimestamp = now.toISOString();
  const uniqueId = `${Date.now()}:${Math.floor(Math.random() * 1_000_000)}`;

  await collection.insertOne({
    serverName,
    ...entry,
    path: normalizedPath,
    timestamp: normalizedTimestamp,
    _id: uniqueId,
  });

  await collection
    .find({ serverName }, { projection: { _id: 1 } })
    .sort({ timestamp: -1 })
    .skip(200)
    .toArray()
    .then(async (overflow) => {
      if (!overflow.length) return;
      const ids = overflow.map((doc) => doc._id);
      if (!ids.length) return;
      await collection.deleteMany({ _id: { $in: ids } });
    });

  await notifyChange();
}

export async function getRequestLogs(serverName: string): Promise<ApiRequestLog[]> {
  const collection = await logsCollection();
  const docs = await collection
    .find(
      { serverName },
      {
        projection: {
          _id: 1,
          timestamp: 1,
          method: 1,
          path: 1,
          slug: 1,
          queryParams: 1,
          proxyTargetUrl: 1,
          body: 1,
          headers: 1,
          responseStatus: 1,
          responseBody: 1,
          responseHeaders: 1,
        },
      },
    )
    .sort({ timestamp: -1 })
    .limit(200)
    .toArray();

  return docs.map((doc) => {
    return {
      id: parseLogIndexFromId(doc._id),
      timestamp: doc.timestamp,
      method: doc.method,
      path: doc.path,
      slug: doc.slug ?? [],
      queryParams: doc.queryParams ?? {},
      proxyTargetUrl: doc.proxyTargetUrl,
      body: doc.body ?? null,
      headers: doc.headers ?? {},
      responseStatus: doc.responseStatus ?? 200,
      responseBody: doc.responseBody ?? null,
      responseHeaders: doc.responseHeaders ?? {},
    };
  });
}

export async function getRouteStats(serverName: string): Promise<ApiRouteStat[]> {
  const collection = await logsCollection();

  const grouped = await collection
    .aggregate<{
      _id: { method: string; path: string };
      count: number;
      firstTimestamp: string;
      lastTimestamp: string;
    }>([
      { $match: { serverName } },
      {
        $group: {
          _id: { method: "$method", path: "$path" },
          count: { $sum: 1 },
          firstTimestamp: { $min: "$timestamp" },
          lastTimestamp: { $max: "$timestamp" },
        },
      },
      {
        $project: {
          _id: 1,
          count: 1,
          firstTimestamp: 1,
          lastTimestamp: 1,
        },
      },
    ])
    .toArray();

  return grouped
    .map((row) => ({
      id: `${row._id.method} ${row._id.path}`,
      method: row._id.method,
      path: row._id.path,
      count: row.count,
      firstTimestamp: row.firstTimestamp ?? "",
      lastTimestamp: row.lastTimestamp ?? "",
    }))
    .sort((a, b) =>
      a.path === b.path
        ? a.method.localeCompare(b.method)
        : a.path.localeCompare(b.path),
    );
}

export async function getRouteStatsWithConfigs(
  serverName: string,
): Promise<ApiRouteStat[]> {
  const [baseStats, configs] = await Promise.all([
    getRouteStats(serverName),
    getAllRouteConfigs(serverName),
  ]);
  const map = new Map<string, ApiRouteStat>();

  for (const stat of baseStats) {
    map.set(`${stat.method} ${stat.path}`, stat);
  }

  for (const cfg of configs) {
    const key = configKey(cfg.method, cfg.path);
    if (!map.has(key)) {
      map.set(key, {
        id: key,
        method: cfg.method.toUpperCase(),
        path: normalizePath(cfg.path),
        count: 0,
        firstTimestamp: "",
        lastTimestamp: "",
      });
    }
  }

  return Array.from(map.values()).sort((a, b) =>
    a.path === b.path
      ? a.method.localeCompare(b.method)
      : a.path.localeCompare(b.path),
  );
}

export async function setRouteConfig(
  serverName: string,
  config: ApiRouteConfig,
): Promise<ApiRouteConfig> {
  const collection = await routeConfigsCollection();
  const normalized = mapConfig(config);
  const key = configKey(normalized.method, normalized.path);

  await collection.updateOne(
    { _id: key, serverName },
    {
      $set: {
        serverName,
        method: normalized.method,
        path: normalized.path,
        status: normalized.status,
        body: normalized.body,
        headers: normalized.headers,
        proxyMode: normalized.proxyMode,
        proxyUrl: normalized.proxyUrl,
      },
    },
    { upsert: true },
  );

  await notifyChange();
  return normalized;
}

export async function getRouteConfigFor(
  serverName: string,
  method: string,
  path: string,
): Promise<ApiRouteConfig | undefined> {
  const collection = await routeConfigsCollection();
  const key = configKey(method, normalizePath(path));
  const doc = await collection.findOne({ _id: key, serverName });
  if (!doc) return undefined;
  return mapConfig(doc);
}

export async function getAllRouteConfigs(
  serverName: string,
): Promise<ApiRouteConfig[]> {
  const collection = await routeConfigsCollection();
  const docs = await collection.find({ serverName }).toArray();
  return docs.map((doc) => mapConfig(doc));
}

export async function deleteRouteConfig(
  serverName: string,
  method: string,
  path: string,
): Promise<boolean> {
  const collection = await routeConfigsCollection();
  const key = configKey(method, normalizePath(path));
  const result = await collection.deleteOne({ _id: key, serverName });
  if (result.deletedCount) {
    await notifyChange();
  }
  return Boolean(result.deletedCount);
}

export async function clearRequestLogs(serverName: string): Promise<void> {
  const collection = await logsCollection();
  await collection.deleteMany({ serverName });
  await notifyChange();
}

export async function getSnapshot(serverName: string) {
  const [logs, routes] = await Promise.all([
    getRequestLogs(serverName),
    getRouteStatsWithConfigs(serverName),
  ]);
  return { logs, routes };
}

export function subscribeToChanges(
  serverName: string,
  listener: ChangeListener,
): () => void {
  const entry: ListenerEntry = { serverName, listener };
  listeners.add(entry);
  return () => {
    listeners.delete(entry);
  };
}

async function notifyChange() {
  if (listeners.size === 0) return;
  for (const entry of listeners) {
    const { serverName, listener } = entry;
    const snapshot = await getSnapshot(serverName);
    try {
      listener(snapshot);
    } catch {
      // ignore listener errors
    }
  }
}


