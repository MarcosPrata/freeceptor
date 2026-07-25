import { getDb } from "@/lib/server/mongo";

export type ApiRequestLog = {
  id: string;
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
  /** Origem da config usada na resposta: override da rota, proxy da API, ou padrão. */
  configSource?: "route" | "api" | "none";
  /** True quando a rota sobrescreveu um proxy ativo da API. */
  overrodeApiProxy?: boolean;
  /** True quando tentou proxy client mas o cliente estava offline/ausente. */
  proxyClientOffline?: boolean;
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
  /** Presente quando a rota tem override explícito do comportamento padrão. */
  overrideMode?: "mock" | "url" | "client";
  /** Cliente do proxy da rota, quando overrideMode é client. */
  proxyClientId?: string;
};

export type ProxyMode = "disabled" | "url" | "client";

export type MockMatchSource = "header" | "query" | "path" | "body";
export type MockBodyKind = "json" | "raw";
export type MockOperator =
  | "equals"
  | "notEquals"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "exists"
  | "notExists";

export type DynamicMockCondition = {
  source: MockMatchSource;
  /** header name, query key, path param name, ou dot-path JSON */
  key?: string;
  bodyKind?: MockBodyKind;
  operator: MockOperator;
  value?: string;
};

export type MockJoinOperator = "and" | "or";

export type DynamicMockRule = {
  id: string;
  conditions: DynamicMockCondition[];
  /** joins[i] liga conditions[i] com conditions[i+1]; length === conditions.length - 1 */
  joins: MockJoinOperator[];
  status: number;
  body: unknown;
  headers: Record<string, string>;
};

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
  // true when saved explicitly by the user via the UI.
  // false/undefined for auto-created configs (first call to a route).
  // Explicit configs override the API-level proxy even when proxyMode is false (mock).
  explicitlyConfigured?: boolean;
  /** @deprecated Kept for older persisted configs; mock always uses dynamicRules + fallback. */
  mockMode?: "static" | "dynamic";
  dynamicRules?: DynamicMockRule[];
};

export type ApiConfig = {
  apiName: string;
  proxyMode?: boolean;
  proxyUrl?: string;
  proxyToClient?: boolean;
  proxyClientId?: string;
  proxyServiceName?: string;
  /** Ordem de exibição na UI (menor = mais à esquerda). */
  sortOrder?: number;
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
  /** True quando a config da rota sobrescreveu um proxy ativo da API. */
  overrodeApiProxy: boolean;
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

type ActivityListener = (apiName: string) => void;

type ActivityEntry = {
  serverName: string;
  listener: ActivityListener;
};

const listeners = new Set<ListenerEntry>();
const activityListeners = new Set<ActivityEntry>();

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

/**
 * Returns true if the segment is a path param (`:id`) or legacy `*`.
 */
export function isPathParamSegment(seg: string): boolean {
  return seg === "*" || (seg.startsWith(":") && seg.length > 1);
}

export function pathHasParams(path: string): boolean {
  return path.split("/").filter(Boolean).some(isPathParamSegment);
}

/**
 * Returns true if requestPath matches patternPath.
 * Pattern segments may be literals, `:name`, or legacy `*` (one segment).
 */
export function pathMatchesPattern(requestPath: string, patternPath: string): boolean {
  const req = requestPath.split("/").filter(Boolean);
  const pat = patternPath.split("/").filter(Boolean);
  if (req.length !== pat.length) return false;
  return req.every((seg, i) => isPathParamSegment(pat[i]) || pat[i] === seg);
}

/**
 * Extracts named path params from a request path against a pattern.
 * Legacy `*` segments are captured as `param0`, `param1`, …
 */
export function extractPathParams(
  requestPath: string,
  patternPath: string,
): Record<string, string> {
  const req = requestPath.split("/").filter(Boolean);
  const pat = patternPath.split("/").filter(Boolean);
  const out: Record<string, string> = {};
  if (req.length !== pat.length) return out;

  let anon = 0;
  for (let i = 0; i < pat.length; i++) {
    const p = pat[i];
    if (p === "*") {
      out[`param${anon++}`] = req[i];
    } else if (p.startsWith(":") && p.length > 1) {
      out[p.slice(1)] = req[i];
    }
  }
  return out;
}

/**
 * Specificity score: higher = fewer params = more specific.
 */
function patternSpecificity(path: string): number {
  return path.split("/").filter((s) => s && !isPathParamSegment(s)).length;
}

function mergeStatInto(target: ApiRouteStat, source: ApiRouteStat): void {
  target.count += source.count;
  if (
    source.firstTimestamp &&
    (!target.firstTimestamp || source.firstTimestamp < target.firstTimestamp)
  ) {
    target.firstTimestamp = source.firstTimestamp;
  }
  if (
    source.lastTimestamp &&
    (!target.lastTimestamp || source.lastTimestamp > target.lastTimestamp)
  ) {
    target.lastTimestamp = source.lastTimestamp;
  }
  if (!target.overrideMode && source.overrideMode) {
    target.overrideMode = source.overrideMode;
  }
  if (!target.proxyClientId && source.proxyClientId) {
    target.proxyClientId = source.proxyClientId;
  }
}

function overrideModeFromConfig(
  cfg: ApiRouteConfig,
): ApiRouteStat["overrideMode"] {
  if (
    cfg.proxyToClient &&
    cfg.proxyClientId?.trim() &&
    cfg.proxyServiceName?.trim()
  ) {
    return "client";
  }
  if (cfg.proxyMode && cfg.proxyUrl?.trim()) {
    return "url";
  }
  if (cfg.explicitlyConfigured) {
    return "mock";
  }
  return undefined;
}

function proxyClientIdFromConfig(cfg: ApiRouteConfig): string | undefined {
  if (
    cfg.proxyToClient &&
    cfg.proxyClientId?.trim() &&
    cfg.proxyServiceName?.trim()
  ) {
    return cfg.proxyClientId.trim();
  }
  return undefined;
}

function routeStatFromConfig(cfg: ApiRouteConfig, apiName: string): ApiRouteStat {
  return {
    id: configKey(cfg.method, cfg.path),
    method: cfg.method.toUpperCase(),
    path: normalizePath(cfg.path),
    apiName,
    count: 0,
    firstTimestamp: "",
    lastTimestamp: "",
    overrideMode: overrideModeFromConfig(cfg),
    proxyClientId: proxyClientIdFromConfig(cfg),
  };
}

function mapMockCondition(raw: unknown): DynamicMockCondition | null {
  if (!raw || typeof raw !== "object") return null;
  const condition = raw as Partial<DynamicMockCondition>;
  return {
    source: condition.source ?? "query",
    key: condition.key?.trim() || undefined,
    bodyKind: condition.bodyKind === "raw" ? "raw" : "json",
    operator: condition.operator ?? "equals",
    value: condition.value,
  };
}

function normalizeJoins(
  joins: unknown,
  conditionCount: number,
): MockJoinOperator[] {
  const needed = Math.max(0, conditionCount - 1);
  const rawList = Array.isArray(joins) ? joins : [];
  const out: MockJoinOperator[] = [];
  for (let i = 0; i < needed; i++) {
    out.push(rawList[i] === "or" ? "or" : "and");
  }
  return out;
}

function mapDynamicRules(rules: unknown): DynamicMockRule[] | undefined {
  if (!Array.isArray(rules)) return undefined;
  const mapped = rules
    .map((raw): DynamicMockRule | null => {
      if (!raw || typeof raw !== "object") return null;
      const rule = raw as Partial<DynamicMockRule> & {
        condition?: DynamicMockCondition;
      };
      let conditions: DynamicMockCondition[] = [];
      if (Array.isArray(rule.conditions) && rule.conditions.length > 0) {
        conditions = rule.conditions
          .map(mapMockCondition)
          .filter((c): c is DynamicMockCondition => c != null);
      } else if (rule.condition && typeof rule.condition === "object") {
        const legacy = mapMockCondition(rule.condition);
        if (legacy) conditions = [legacy];
      }
      if (conditions.length === 0) return null;
      const id =
        typeof rule.id === "string" && rule.id.trim()
          ? rule.id.trim()
          : `rule-${Math.random().toString(36).slice(2, 10)}`;
      return {
        id,
        conditions,
        joins: normalizeJoins(rule.joins, conditions.length),
        status: typeof rule.status === "number" ? rule.status : 200,
        body: rule.body ?? { status: "ok" },
        headers:
          rule.headers && typeof rule.headers === "object"
            ? (rule.headers as Record<string, string>)
            : {},
      };
    })
    .filter((r): r is DynamicMockRule => r != null);
  return mapped.length > 0 ? mapped : undefined;
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
    explicitlyConfigured: Boolean(config.explicitlyConfigured),
    mockMode: "dynamic",
    dynamicRules: mapDynamicRules(config.dynamicRules),
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
    sortOrder:
      typeof doc.sortOrder === "number" && Number.isFinite(doc.sortOrder)
        ? doc.sortOrder
        : undefined,
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
  notifyRequestActivity(serverName, normalizedApi);
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
          configSource: 1,
          overrodeApiProxy: 1,
          proxyClientOffline: 1,
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
      id: String(doc._id),
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
      configSource:
        doc.configSource === "route" ||
        doc.configSource === "api" ||
        doc.configSource === "none"
          ? doc.configSource
          : undefined,
      overrodeApiProxy: Boolean(doc.overrodeApiProxy),
      proxyClientOffline: Boolean(doc.proxyClientOffline),
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

  const configByKey = new Map<string, ApiRouteConfig>();
  for (const cfg of configs) {
    configByKey.set(configKey(cfg.method, cfg.path), cfg);
  }

  const patternConfigs = configs.filter((c) => pathHasParams(c.path));
  const map = new Map<string, ApiRouteStat>();

  // Seed entries for every configured route (including patterns with count 0).
  for (const cfg of configs) {
    const key = configKey(cfg.method, cfg.path);
    if (!map.has(key)) {
      map.set(key, routeStatFromConfig(cfg, normalizedApi));
    }
  }

  for (const stat of baseStats) {
    const normalizedStatPath = normalizePath(stat.path);
    const statKey = configKey(stat.method, normalizedStatPath);

    // Exact config exists → keep stat on its own entry (exact beats pattern).
    const exactConfig = configByKey.get(statKey);
    if (exactConfig && normalizePath(exactConfig.path) === normalizedStatPath) {
      const existing = map.get(statKey);
      if (existing) {
        mergeStatInto(existing, stat);
      } else {
        map.set(statKey, {
          ...stat,
          path: normalizedStatPath,
          overrideMode: overrideModeFromConfig(exactConfig),
          proxyClientId: proxyClientIdFromConfig(exactConfig),
        });
      }
      continue;
    }

    // No exact config → merge into best matching pattern config if any.
    const matchingPatterns = patternConfigs
      .filter(
        (c) =>
          c.method.toUpperCase() === stat.method.toUpperCase() &&
          pathMatchesPattern(normalizedStatPath, c.path),
      )
      .sort((a, b) => patternSpecificity(b.path) - patternSpecificity(a.path));

    if (matchingPatterns.length > 0) {
      const best = matchingPatterns[0];
      const patternKey = configKey(best.method, best.path);
      const existing =
        map.get(patternKey) ?? routeStatFromConfig(best, normalizedApi);
      mergeStatInto(existing, stat);
      map.set(patternKey, existing);
      continue;
    }

    // No config covers this stat — show as standalone discovered route.
    map.set(statKey, { ...stat, path: normalizedStatPath });
  }

  return Array.from(map.values()).sort((a, b) =>
    a.path === b.path
      ? a.method.localeCompare(b.method)
      : a.path.localeCompare(b.path),
  );
}

/**
 * Returns routes (stats + configs) that would be absorbed by converting to a wildcard pattern.
 * Used by the UI merge confirmation modal before converting a path segment to `*`.
 */
export async function getRoutesAffectedByWildcard(
  serverName: string,
  apiName: string,
  method: string,
  patternPath: string,
  excludePath?: string,
): Promise<ApiRouteStat[]> {
  const normalizedApi = normalizeApiName(apiName);
  const normalizedPattern = normalizePath(patternPath);
  const normalizedExclude = excludePath ? normalizePath(excludePath) : undefined;
  const upperMethod = method.toUpperCase();

  const [stats, configs] = await Promise.all([
    getRouteStats(serverName, normalizedApi),
    getAllRouteConfigs(serverName, normalizedApi),
  ]);

  const routeMap = new Map<string, ApiRouteStat>();

  for (const stat of stats) {
    routeMap.set(configKey(stat.method, stat.path), stat);
  }

  for (const cfg of configs) {
    const key = configKey(cfg.method, cfg.path);
    if (!routeMap.has(key)) {
      routeMap.set(key, {
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

  return Array.from(routeMap.values())
    .filter((route) => {
      if (route.method.toUpperCase() !== upperMethod) return false;
      const routePath = normalizePath(route.path);
      if (routePath === normalizedPattern) return false;
      if (normalizedExclude && routePath === normalizedExclude) return false;
      return pathMatchesPattern(routePath, normalizedPattern);
    })
    .sort((a, b) =>
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
        explicitlyConfigured: normalized.explicitlyConfigured ?? false,
        mockMode: "dynamic",
        dynamicRules: normalized.dynamicRules ?? [],
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
  const normalizedPath = normalizePath(path);

  // 1. Try exact match first (highest priority)
  const exactDoc = await collection.findOne({
    serverName,
    apiName: normalizedApi,
    method: method.toUpperCase(),
    path: normalizedPath,
  });
  if (exactDoc) return mapConfig(exactDoc);

  // 2. Pattern fallback: :param and legacy *
  const allDocs = await collection
    .find({ serverName, apiName: normalizedApi, method: method.toUpperCase() })
    .toArray();

  const patternMatches = allDocs
    .filter((doc) => pathHasParams(doc.path) && pathMatchesPattern(normalizedPath, doc.path))
    .sort((a, b) => patternSpecificity(b.path) - patternSpecificity(a.path));

  return patternMatches.length > 0 ? mapConfig(patternMatches[0]) : undefined;
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

async function nextApiSortOrder(serverName: string): Promise<number> {
  const collection = await apiConfigsCollection();
  const docs = await collection
    .find({ serverName }, { projection: { sortOrder: 1 } })
    .toArray();
  let max = -1;
  for (const doc of docs) {
    if (typeof doc.sortOrder === "number" && doc.sortOrder > max) {
      max = doc.sortOrder;
    }
  }
  return max + 1;
}

export async function setApiConfig(
  serverName: string,
  config: ApiConfig,
): Promise<ApiConfig> {
  const collection = await apiConfigsCollection();
  const normalized = mapApiConfig(config);
  const existing = await collection.findOne({
    serverName,
    apiName: normalized.apiName,
  });
  const sortOrder =
    typeof normalized.sortOrder === "number"
      ? normalized.sortOrder
      : typeof existing?.sortOrder === "number"
        ? existing.sortOrder
        : await nextApiSortOrder(serverName);

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
        sortOrder,
      },
    },
    { upsert: true },
  );

  return { ...normalized, sortOrder };
}

export async function getAllApiConfigs(serverName: string): Promise<ApiConfig[]> {
  const collection = await apiConfigsCollection();
  const docs = await collection.find({ serverName }).toArray();
  return docs
    .map((doc) => mapApiConfig(doc))
    .sort((a, b) => {
      const ao = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
      const bo = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      return a.apiName.localeCompare(b.apiName);
    });
}

/** Persiste a ordem das APIs (lista de apiNames da esquerda para a direita). */
export async function setApiOrder(
  serverName: string,
  order: string[],
): Promise<ApiConfig[]> {
  const collection = await apiConfigsCollection();
  const normalizedOrder = order
    .map((name) => normalizeApiName(name))
    .filter(Boolean);

  await Promise.all(
    normalizedOrder.map((apiName, index) =>
      collection.updateOne(
        { serverName, apiName },
        { $set: { sortOrder: index } },
      ),
    ),
  );

  return getAllApiConfigs(serverName);
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
  const apiConfig = await getApiConfig(serverName, normalizedApi);

  const defaultStatus = 200;
  const defaultBody: unknown = { status: "ok" };
  const defaultHeaders: Record<string, string> = {};
  const hasApiProxy = Boolean(
    apiConfig &&
      ((apiConfig.proxyMode && apiConfig.proxyUrl) ||
        (apiConfig.proxyToClient &&
          apiConfig.proxyClientId &&
          apiConfig.proxyServiceName)),
  );

  if (routeConfig) {
    const hasRouteProxy =
      (routeConfig.proxyMode && routeConfig.proxyUrl) ||
      (routeConfig.proxyToClient && routeConfig.proxyClientId && routeConfig.proxyServiceName);

    if (hasRouteProxy) {
      // Route has explicit proxy config → highest priority, always overrides API proxy.
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
        overrodeApiProxy: hasApiProxy,
      };
    }

    if (routeConfig.explicitlyConfigured) {
      // Route was explicitly set to mock via the UI (proxyMode: false).
      // Even if the API has a proxy, the user's mock override wins.
      return {
        proxyMode: false,
        proxyUrl: "",
        proxyToClient: false,
        proxyClientId: "",
        proxyServiceName: "",
        routeStatus: routeConfig.status ?? defaultStatus,
        routeBody: routeConfig.body ?? defaultBody,
        routeHeaders: routeConfig.headers ?? defaultHeaders,
        source: "route",
        overrodeApiProxy: hasApiProxy,
      };
    }

    // Route config was auto-created (first call to this route) and has no explicit proxy.
    // Fall through so the API-level proxy is still applied for this route.
  }

  // Check API-level proxy config (applies when route has no explicit proxy)
  if (hasApiProxy && apiConfig) {
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
      overrodeApiProxy: false,
    };
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
    overrodeApiProxy: false,
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

/** Notifica qualquer atividade de request em qualquer API do server (para badges). */
export function subscribeToServerActivity(
  serverName: string,
  listener: ActivityListener,
): () => void {
  const entry: ActivityEntry = { serverName, listener };
  activityListeners.add(entry);
  return () => {
    activityListeners.delete(entry);
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

function notifyRequestActivity(serverName: string, apiName: string) {
  if (activityListeners.size === 0) return;
  const normalizedApi = normalizeApiName(apiName);
  for (const entry of activityListeners) {
    if (entry.serverName !== serverName) continue;
    try {
      entry.listener(normalizedApi);
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
