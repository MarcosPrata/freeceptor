import { getDb } from "@/lib/server/mongo";

export type ApiRequestLog = {
  id: number;
  timestamp: string;
  method: string;
  path: string;
  slug: string[];
  apiName: string;
  queryParams: Record<string, string | string[]>;
  proxyTargetUrl?: string;
  proxyResolvedUrl?: string;
  proxyClientId?: string;
  proxyClientName?: string;
  proxyServiceName?: string;
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
  apiName: string;
  count: number;
  firstTimestamp: string;
  lastTimestamp: string;
};

export type ProxyMode = "disabled" | "url" | "client";

export type ApiRouteConfig = {
  apiName: string;
  method: string;
  path: string;
  status: number;
  body: unknown;
  headers: Record<string, string>;
  proxyMode?: boolean;
  proxyUrl?: string;
  proxyToClient?: boolean;
  proxyClientId?: string;
  proxyServiceName?: string;
};

export type ApiConfig = {
  apiName: string;
  proxyMode?: boolean;
  proxyUrl?: string;
  proxyToClient?: boolean;
  proxyClientId?: string;
  proxyServiceName?: string;
};

export type ResolvedProxyConfig = {
  proxyMode: boolean;
  proxyUrl: string;
  proxyToClient: boolean;
  proxyClientId: string;
  proxyServiceName: string;
  routeStatus: number;
  routeBody: unknown;
  routeHeaders: Record<string, string>;
  source: "route" | "api" | "none";
};

type LogDoc = {
  _id: string;
  serverName: string;
  apiName: string;
} & Omit<ApiRequestLog, "id" | "apiName">;

type RouteConfigDoc = {
  serverName: string;
} & ApiRouteConfig;

type ApiConfigDoc = {
  serverName: string;
} & ApiConfig;

type ChangeListener = (payload: {
  logs: ApiRequestLog[];
  routes: ApiRouteStat[];
}) => void;

type ListenerEntry = {
  serverName: string;
  apiName: string;
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

async function apiConfigsCollection() {
  const db = await getDb();
  return db.collection<ApiConfigDoc>("api_configs");
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

function normalizeApiName(apiName: string): string {
  return apiName?.trim().toLowerCase() || "default";
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
    apiName: normalizeApiName((config as RouteConfigDoc).apiName ?? "default"),
    method: config.method.toUpperCase(),
    path: normalizePath(config.path),
    status: config.status || 200,
    headers: config.headers ?? {},
    proxyMode: Boolean(config.proxyMode),
    proxyUrl: config.proxyUrl?.trim() ?? "",
    proxyToClient: Boolean(config.proxyToClient),
    proxyClientId: config.proxyClientId?.trim() ?? "",
    proxyServiceName: config.proxyServiceName?.trim() ?? "",
  };
}

function mapApiConfig(doc: ApiConfig | ApiConfigDoc): ApiConfig {
  return {
    apiName: normalizeApiName(doc.apiName),
    proxyMode: Boolean(doc.proxyMode),
    proxyUrl: doc.proxyUrl?.trim() ?? "",
    proxyToClient: Boolean(doc.proxyToClient),
    proxyClientId: doc.proxyClientId?.trim() ?? "",
    proxyServiceName: doc.proxyServiceName?.trim() ?? "",
  };
}

export async function addRequestLog(
  serverName: string,
  apiName: string,
  entry: Omit<ApiRequestLog, "id" | "timestamp" | "apiName">,
): Promise<void> {
  const collection = await logsCollection();
  const now = new Date();
  const normalizedPath = normalizePath(entry.path);
  const normalizedTimestamp = now.toISOString();
  const uniqueId = `${Date.now()}:${Math.floor(Math.random() * 1_000_000)}`;
  const normalizedApi = normalizeApiName(apiName);

  await collection.insertOne({
    serverName,
    apiName: normalizedApi,
    ...entry,
    path: normalizedPath,
    timestamp: normalizedTimestamp,
    _id: uniqueId,
  });

  await collection
    .find({ serverName, apiName: normalizedApi }, { projection: { _id: 1 } })
    .sort({ timestamp: -1 })
    .skip(200)
    .toArray()
    .then(async (overflow) => {
      if (!overflow.length) return;
      const ids = overflow.map((doc) => doc._id);
      if (!ids.length) return;
      await collection.deleteMany({ _id: { $in: ids } });
    });

  await notifyChange(serverName, normalizedApi);
}

export async function getRequestLogs(
  serverName: string,
  apiName: string,
): Promise<ApiRequestLog[]> {
  const collection = await logsCollection();
  const normalizedApi = normalizeApiName(apiName);
  const docs = await collection
    .find(
      { serverName, apiName: normalizedApi },
      {
        projection: {
          _id: 1,
          timestamp: 1,
          method: 1,
          path: 1,
          slug: 1,
          apiName: 1,
          queryParams: 1,
          proxyTargetUrl: 1,
          proxyResolvedUrl: 1,
          proxyClientId: 1,
          proxyClientName: 1,
          proxyServiceName: 1,
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
      apiName: doc.apiName ?? normalizedApi,
      queryParams: doc.queryParams ?? {},
      proxyTargetUrl: doc.proxyTargetUrl,
      proxyResolvedUrl: doc.proxyResolvedUrl,
      proxyClientId: doc.proxyClientId,
      proxyClientName: doc.proxyClientName,
      proxyServiceName: doc.proxyServiceName,
      body: doc.body ?? null,
      headers: doc.headers ?? {},
      responseStatus: doc.responseStatus ?? 200,
      responseBody: doc.responseBody ?? null,
      responseHeaders: doc.responseHeaders ?? {},
    };
  });
}

export async function getRouteStats(
  serverName: string,
  apiName: string,
): Promise<ApiRouteStat[]> {
  const collection = await logsCollection();
  const normalizedApi = normalizeApiName(apiName);

  const grouped = await collection
    .aggregate<{
      _id: { method: string; path: string };
      count: number;
      firstTimestamp: string;
      lastTimestamp: string;
    }>([
      { $match: { serverName, apiName: normalizedApi } },
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
      apiName: normalizedApi,
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
  apiName: string,
): Promise<ApiRouteStat[]> {
  const normalizedApi = normalizeApiName(apiName);
  const [baseStats, configs] = await Promise.all([
    getRouteStats(serverName, normalizedApi),
    getAllRouteConfigs(serverName, normalizedApi),
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
        apiName: normalizedApi,
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

  await collection.updateOne(
    {
      serverName,
      apiName: normalized.apiName,
      method: normalized.method,
      path: normalized.path,
    },
    {
      $set: {
        serverName,
        apiName: normalized.apiName,
        method: normalized.method,
        path: normalized.path,
        status: normalized.status,
        body: normalized.body,
        headers: normalized.headers,
        proxyMode: normalized.proxyMode,
        proxyUrl: normalized.proxyUrl,
        proxyToClient: normalized.proxyToClient,
        proxyClientId: normalized.proxyClientId,
        proxyServiceName: normalized.proxyServiceName,
      },
    },
    { upsert: true },
  );

  await notifyChange(serverName, normalized.apiName);
  return normalized;
}

export async function getRouteConfigFor(
  serverName: string,
  apiName: string,
  method: string,
  path: string,
): Promise<ApiRouteConfig | undefined> {
  const collection = await routeConfigsCollection();
  const normalizedApi = normalizeApiName(apiName);
  const doc = await collection.findOne({
    serverName,
    apiName: normalizedApi,
    method: method.toUpperCase(),
    path: normalizePath(path),
  });
  if (!doc) return undefined;
  return mapConfig(doc);
}

export async function getAllRouteConfigs(
  serverName: string,
  apiName: string,
): Promise<ApiRouteConfig[]> {
  const collection = await routeConfigsCollection();
  const normalizedApi = normalizeApiName(apiName);
  const docs = await collection.find({ serverName, apiName: normalizedApi }).toArray();
  return docs.map((doc) => mapConfig(doc));
}

export async function deleteRouteConfig(
  serverName: string,
  apiName: string,
  method: string,
  path: string,
): Promise<boolean> {
  const collection = await routeConfigsCollection();
  const normalizedApi = normalizeApiName(apiName);
  const result = await collection.deleteOne({
    serverName,
    apiName: normalizedApi,
    method: method.toUpperCase(),
    path: normalizePath(path),
  });
  if (result.deletedCount) {
    await notifyChange(serverName, normalizedApi);
  }
  return Boolean(result.deletedCount);
}

export async function clearRequestLogs(
  serverName: string,
  apiName: string,
): Promise<void> {
  const collection = await logsCollection();
  const normalizedApi = normalizeApiName(apiName);
  await collection.deleteMany({ serverName, apiName: normalizedApi });
  await notifyChange(serverName, normalizedApi);
}

// --- API-level config CRUD ---

export async function getApiConfig(
  serverName: string,
  apiName: string,
): Promise<ApiConfig | undefined> {
  const collection = await apiConfigsCollection();
  const normalizedApi = normalizeApiName(apiName);
  const doc = await collection.findOne({ serverName, apiName: normalizedApi });
  if (!doc) return undefined;
  return mapApiConfig(doc);
}

export async function setApiConfig(
  serverName: string,
  config: ApiConfig,
): Promise<ApiConfig> {
  const collection = await apiConfigsCollection();
  const normalized = mapApiConfig(config);

  await collection.updateOne(
    { serverName, apiName: normalized.apiName },
    {
      $set: {
        serverName,
        apiName: normalized.apiName,
        proxyMode: normalized.proxyMode,
        proxyUrl: normalized.proxyUrl,
        proxyToClient: normalized.proxyToClient,
        proxyClientId: normalized.proxyClientId,
        proxyServiceName: normalized.proxyServiceName,
      },
    },
    { upsert: true },
  );

  return normalized;
}

export async function getAllApiConfigs(serverName: string): Promise<ApiConfig[]> {
  const collection = await apiConfigsCollection();
  const docs = await collection.find({ serverName }).toArray();
  return docs.map((doc) => mapApiConfig(doc));
}

export async function deleteApiConfig(
  serverName: string,
  apiName: string,
): Promise<boolean> {
  const collection = await apiConfigsCollection();
  const normalizedApi = normalizeApiName(apiName);
  const result = await collection.deleteOne({ serverName, apiName: normalizedApi });
  return Boolean(result.deletedCount);
}

/** Deletes ALL data associated with an API: config, route configs, and request logs. */
export async function deleteApiAndAllData(
  serverName: string,
  apiName: string,
): Promise<void> {
  const normalizedApi = normalizeApiName(apiName);
  const [apiColl, routeColl, logColl] = await Promise.all([
    apiConfigsCollection(),
    routeConfigsCollection(),
    logsCollection(),
  ]);
  await Promise.all([
    apiColl.deleteOne({ serverName, apiName: normalizedApi }),
    routeColl.deleteMany({ serverName, apiName: normalizedApi }),
    logColl.deleteMany({ serverName, apiName: normalizedApi }),
  ]);
  await notifyChange(serverName, normalizedApi);
}

// --- Proxy resolution with hierarchy: route > api > none ---

export async function resolveProxyConfig(
  serverName: string,
  apiName: string,
  method: string,
  path: string,
): Promise<ResolvedProxyConfig> {
  const normalizedApi = normalizeApiName(apiName);
  const routeConfig = await getRouteConfigFor(serverName, normalizedApi, method, path);

  const defaultStatus = 200;
  const defaultBody: unknown = { status: "ok" };
  const defaultHeaders: Record<string, string> = {};

  // Route has EXPLICIT proxy config → highest priority, overrides API
  if (routeConfig) {
    const hasRouteProxy =
      (routeConfig.proxyMode && routeConfig.proxyUrl) ||
      (routeConfig.proxyToClient && routeConfig.proxyClientId && routeConfig.proxyServiceName);

    if (hasRouteProxy) {
      return {
        proxyMode: Boolean(routeConfig.proxyMode),
        proxyUrl: routeConfig.proxyUrl ?? "",
        proxyToClient: Boolean(routeConfig.proxyToClient),
        proxyClientId: routeConfig.proxyClientId ?? "",
        proxyServiceName: routeConfig.proxyServiceName ?? "",
        routeStatus: routeConfig.status ?? defaultStatus,
        routeBody: routeConfig.body ?? defaultBody,
        routeHeaders: routeConfig.headers ?? defaultHeaders,
        source: "route",
      };
    }
    // Route exists but no explicit proxy → fall through to check API config.
    // A route without proxy should still inherit the API-level proxy if configured.
  }

  // Check API-level proxy config (applies when route has no explicit proxy)
  const apiConfig = await getApiConfig(serverName, normalizedApi);
  if (apiConfig) {
    const hasApiProxy =
      (apiConfig.proxyMode && apiConfig.proxyUrl) ||
      (apiConfig.proxyToClient && apiConfig.proxyClientId && apiConfig.proxyServiceName);

    if (hasApiProxy) {
      return {
        proxyMode: Boolean(apiConfig.proxyMode),
        proxyUrl: apiConfig.proxyUrl ?? "",
        proxyToClient: Boolean(apiConfig.proxyToClient),
        proxyClientId: apiConfig.proxyClientId ?? "",
        proxyServiceName: apiConfig.proxyServiceName ?? "",
        routeStatus: routeConfig?.status ?? defaultStatus,
        routeBody: routeConfig?.body ?? defaultBody,
        routeHeaders: routeConfig?.headers ?? defaultHeaders,
        source: "api",
      };
    }
  }

  // No proxy anywhere
  return {
    proxyMode: false,
    proxyUrl: "",
    proxyToClient: false,
    proxyClientId: "",
    proxyServiceName: "",
    routeStatus: routeConfig?.status ?? defaultStatus,
    routeBody: routeConfig?.body ?? defaultBody,
    routeHeaders: routeConfig?.headers ?? defaultHeaders,
    source: "none",
  };
}

export async function getSnapshot(serverName: string, apiName: string) {
  const normalizedApi = normalizeApiName(apiName);
  const [logs, routes] = await Promise.all([
    getRequestLogs(serverName, normalizedApi),
    getRouteStatsWithConfigs(serverName, normalizedApi),
  ]);
  return { logs, routes };
}

export function subscribeToChanges(
  serverName: string,
  apiName: string,
  listener: ChangeListener,
): () => void {
  const normalizedApi = normalizeApiName(apiName);
  const entry: ListenerEntry = { serverName, apiName: normalizedApi, listener };
  listeners.add(entry);
  return () => {
    listeners.delete(entry);
  };
}

async function notifyChange(serverName: string, apiName: string) {
  if (listeners.size === 0) return;
  const normalizedApi = normalizeApiName(apiName);
  for (const entry of listeners) {
    if (entry.serverName !== serverName || entry.apiName !== normalizedApi) continue;
    const snapshot = await getSnapshot(serverName, normalizedApi);
    try {
      entry.listener(snapshot);
    } catch {
      // ignore listener errors
    }
  }
}

// --- Migration helper: backfill apiName='default' for existing records ---

const migratedServers = new Set<string>();

export async function migrateExistingRecords(serverName: string): Promise<void> {
  if (migratedServers.has(serverName)) return;
  migratedServers.add(serverName);

  const logsCol = await logsCollection();
  const routesCol = await routeConfigsCollection();

  await logsCol.updateMany(
    { serverName, apiName: { $exists: false } },
    { $set: { apiName: "default" } },
  );

  await routesCol.updateMany(
    { serverName, apiName: { $exists: false } },
    { $set: { apiName: "default" } },
  );
}
