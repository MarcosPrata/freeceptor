"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type ApiRequestLog = {
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

type ApiRouteStat = {
  id: string;
  method: string;
  path: string;
  apiName: string;
  count: number;
  firstTimestamp: string;
  lastTimestamp: string;
};

type ApiRouteConfig = {
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

type ApiConfig = {
  apiName: string;
  proxyMode?: boolean;
  proxyUrl?: string;
  proxyToClient?: boolean;
  proxyClientId?: string;
  proxyServiceName?: string;
};

type ProxyServiceInfo = {
  name: string;
  port: number;
  host: string;
};

type ProxyClientInfo = {
  clientId: string;
  clientName: string;
  serverName: string;
  localServices: ProxyServiceInfo[];
  connectedAt: string;
  lastHeartbeat: string;
  status: "online" | "offline";
};

type ProxyModeType = "disabled" | "url" | "client";

function normalizePathFront(path: string): string {
  if (!path) return "/";
  let result = path.trim();
  if (!result.startsWith("/")) result = `/${result}`;
  if (result.length > 1 && result.endsWith("/")) {
    result = result.slice(0, -1);
  }
  return result;
}

function statusPillClass(status: number): string {
  if (status >= 200 && status < 300) {
    return "bg-emerald-600 text-white dark:bg-emerald-500 dark:text-zinc-950";
  }
  if (status >= 300 && status < 400) {
    return "bg-blue-600 text-white dark:bg-blue-500 dark:text-zinc-950";
  }
  if (status >= 400 && status < 500) {
    return "bg-amber-500 text-zinc-950 dark:bg-amber-400 dark:text-zinc-950";
  }
  if (status >= 500 && status < 600) {
    return "bg-red-600 text-white dark:bg-red-500 dark:text-zinc-950";
  }
  if (status >= 100 && status < 200) {
    return "bg-cyan-600 text-white dark:bg-cyan-500 dark:text-zinc-950";
  }
  return "bg-zinc-700 text-white dark:bg-zinc-300 dark:text-zinc-950";
}

function renderKeyValueTable(data: Record<string, string | string[]>) {
  const entries = Object.entries(data);
  if (!entries.length) {
    return (
      <div className="rounded border border-zinc-200 bg-white px-2 py-1 text-[11px] text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
        (vazio)
      </div>
    );
  }

  return (
    <div className="max-h-60 overflow-auto rounded border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-950">
      <table className="min-w-full border-separate border-spacing-0 text-[11px]">
        <thead className="sticky top-0 bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
          <tr>
            <th className="border-b border-zinc-200 px-2 py-1 text-left font-medium dark:border-zinc-700">
              Chave
            </th>
            <th className="border-b border-zinc-200 px-2 py-1 text-left font-medium dark:border-zinc-700">
              Valor
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([key, value]) => (
            <tr key={key}>
              <td className="border-b border-zinc-100 px-2 py-1 font-mono text-zinc-700 dark:border-zinc-800 dark:text-zinc-200">
                {key}
              </td>
              <td className="border-b border-zinc-100 px-2 py-1 font-mono text-zinc-700 dark:border-zinc-800 dark:text-zinc-200">
                {Array.isArray(value) ? value.join(", ") : value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function toStringRecord(value: unknown): Record<string, string | string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const input = value as Record<string, unknown>;
  const out: Record<string, string | string[]> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (Array.isArray(raw)) {
      out[key] = raw.map((item) => String(item));
    } else if (raw == null) {
      out[key] = "";
    } else {
      out[key] = String(raw);
    }
  }
  return out;
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function normalizeServerName(value: string): string {
  return value.trim().toLowerCase();
}

function getServerFromPathname(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "server" && parts[1]) {
    return normalizeServerName(decodeURIComponent(parts[1]));
  }
  return "";
}

function buildServerPath(serverName: string): string {
  return `/server/${encodeURIComponent(serverName)}`;
}

type InitialSession = {
  authenticated: boolean;
  serverName: string;
} | null;

export function HomeClient({ initialSession }: { initialSession: InitialSession }) {
  // Session state is initialized from server-side props (SSR reads the cookie),
  // so sessionReady starts as true — no loading screen on hard reloads.
  const [sessionReady, setSessionReady] = useState(true);
  const [authenticated, setAuthenticated] = useState(initialSession?.authenticated ?? false);
  const [currentServerName, setCurrentServerName] = useState(initialSession?.serverName ?? "");
  const [loginServerName, setLoginServerName] = useState(initialSession?.serverName ?? "");
  const [baseUrl, setBaseUrl] = useState(
    process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3002",
  );
  const [loginPassword, setLoginPassword] = useState("");
  const [loginSubmitting, setLoginSubmitting] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [urlCopied, setUrlCopied] = useState(false);

  // API selection
  const [selectedApi, setSelectedApi] = useState("");
  const [apiList, setApiList] = useState<ApiConfig[]>([]);
  const [newApiName, setNewApiName] = useState("");
  const [showNewApiInput, setShowNewApiInput] = useState(false);
  const [deleteApiName, setDeleteApiName] = useState<string | null>(null);
  const [apiConfigOpen, setApiConfigOpen] = useState(false);
  const [apiProxyModeType, setApiProxyModeType] = useState<ProxyModeType>("disabled");
  const [apiProxyUrl, setApiProxyUrl] = useState("");
  const [apiProxyClientId, setApiProxyClientId] = useState("");
  const [apiProxyServiceName, setApiProxyServiceName] = useState("");
  const [apiConfigMessage, setApiConfigMessage] = useState<string | null>(null);
  const [apiConfigSaving, setApiConfigSaving] = useState(false);

  const [logs, setLogs] = useState<ApiRequestLog[]>([]);
  const [routes, setRoutes] = useState<ApiRouteStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<number[]>([]);
  const [activeTab, setActiveTab] = useState<"requests" | "routes">("requests");
  const [configRouteId, setConfigRouteId] = useState<string | null>(null);
  const [configStatus, setConfigStatus] = useState<string>("200");
  const [configBody, setConfigBody] = useState<string>('{"status":"ok"}');
  const [configHeaders, setConfigHeaders] = useState<string>("{}");
  const [configProxyUrl, setConfigProxyUrl] = useState("");
  const [configProxyModeType, setConfigProxyModeType] = useState<ProxyModeType>("disabled");
  const [configProxyClientId, setConfigProxyClientId] = useState("");
  const [configProxyServiceName, setConfigProxyServiceName] = useState("");
  const [connectedClients, setConnectedClients] = useState<ProxyClientInfo[]>([]);
  const [configMessage, setConfigMessage] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importFileName, setImportFileName] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const sseRef = useRef<EventSource | null>(null);
  const hasLoadedOnce = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Initialize from server session so the ref is correct from the start.
  const authenticatedRef = useRef(initialSession?.authenticated ?? false);
  // Tracks the previous selectedApi to detect real API switches (vs. initial mount).
  const prevSelectedApiRef = useRef<string | null>(null);

  // Restore UI state (selected API + active tab + open route config form) from
  // sessionStorage synchronously before the browser paints so the user doesn't
  // lose their place on HMR reloads.
  useLayoutEffect(() => {
    try {
      const api = sessionStorage.getItem("fc_selected_api");
      const tab = sessionStorage.getItem("fc_active_tab");
      if (api) setSelectedApi(api);
      if (tab === "routes") setActiveTab("routes");

      const configStateStr = sessionStorage.getItem("fc_config_state");
      if (configStateStr) {
        const cs = JSON.parse(configStateStr) as {
          configRouteId?: string;
          configStatus?: string;
          configBody?: string;
          configHeaders?: string;
          configProxyModeType?: ProxyModeType;
          configProxyUrl?: string;
          configProxyClientId?: string;
          configProxyServiceName?: string;
        };
        if (cs.configRouteId) setConfigRouteId(cs.configRouteId);
        if (cs.configStatus) setConfigStatus(cs.configStatus);
        if (cs.configBody !== undefined) setConfigBody(cs.configBody);
        if (cs.configHeaders !== undefined) setConfigHeaders(cs.configHeaders);
        if (cs.configProxyModeType) setConfigProxyModeType(cs.configProxyModeType);
        if (cs.configProxyUrl !== undefined) setConfigProxyUrl(cs.configProxyUrl);
        if (cs.configProxyClientId !== undefined) setConfigProxyClientId(cs.configProxyClientId);
        if (cs.configProxyServiceName !== undefined) setConfigProxyServiceName(cs.configProxyServiceName);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_BASE_URL) {
      setBaseUrl(window.location.origin);
    }
  }, []);

  // Diagnóstico: captura o que está causando o reload da página
  useEffect(() => {
    // Mostra o diagnóstico do reload anterior (se existir)
    try {
      const prev = sessionStorage.getItem("fc_debug_unload");
      if (prev) {
        console.warn("[FC-DEBUG] ℹ️ Reload anterior registrado:", JSON.parse(prev));
        sessionStorage.removeItem("fc_debug_unload");
      }
    } catch { /* ignore */ }

    const origPushState = history.pushState.bind(history);
    const origReplaceState = history.replaceState.bind(history);

    history.pushState = function (...args: Parameters<typeof history.pushState>) {
      console.warn("[FC-DEBUG] history.pushState chamado →", args[2]);
      console.trace("[FC-DEBUG] pushState stack:");
      return origPushState(...args);
    };

    history.replaceState = function (...args: Parameters<typeof history.replaceState>) {
      const url = args[2];
      console.warn("[FC-DEBUG] history.replaceState chamado →", url);
      console.trace("[FC-DEBUG] replaceState stack:");
      return origReplaceState(...args);
    };

    const onBeforeUnload = () => {
      console.error("[FC-DEBUG] ⚠️ PÁGINA SENDO DESCARREGADA");
      // Persiste no sessionStorage para ver depois do reload
      try {
        sessionStorage.setItem("fc_debug_unload", JSON.stringify({
          time: new Date().toISOString(),
          url: window.location.href,
          msg: "beforeunload disparado — verifique o console com 'Preserve log' ativado",
        }));
      } catch { /* ignore */ }
    };

    const onPopState = (e: PopStateEvent) => {
      console.warn("[FC-DEBUG] popstate disparado →", e.state, window.location.href);
      console.trace("[FC-DEBUG] popstate stack:");
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("popstate", onPopState);

    return () => {
      history.pushState = origPushState;
      history.replaceState = origReplaceState;
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("popstate", onPopState);
    };
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    try {
      if (selectedApi) {
        sessionStorage.setItem("fc_selected_api", selectedApi);
      } else {
        sessionStorage.removeItem("fc_selected_api");
      }
      // Clear persisted route config state when API changes —
      // route IDs belong to the previous API and would be stale.
      sessionStorage.removeItem("fc_config_state");
    } catch { /* ignore */ }
  }, [authenticated, selectedApi]);

  useEffect(() => {
    if (!authenticated) return;
    try {
      sessionStorage.setItem("fc_active_tab", activeTab);
    } catch { /* ignore */ }
  }, [authenticated, activeTab]);

  // Persists the open route config form state so the user doesn't lose
  // unsaved work when HMR triggers a component remount.
  useEffect(() => {
    if (!authenticated) return;
    try {
      if (!configRouteId) {
        sessionStorage.removeItem("fc_config_state");
      } else {
        sessionStorage.setItem(
          "fc_config_state",
          JSON.stringify({
            configRouteId,
            configStatus,
            configBody,
            configHeaders,
            configProxyModeType,
            configProxyUrl,
            configProxyClientId,
            configProxyServiceName,
          }),
        );
      }
    } catch { /* ignore */ }
  }, [
    authenticated,
    configRouteId,
    configStatus,
    configBody,
    configHeaders,
    configProxyModeType,
    configProxyUrl,
    configProxyClientId,
    configProxyServiceName,
  ]);

  function toggleLogExpanded(id: number) {
    setExpandedIds((prev) =>
      prev.includes(id) ? prev.filter((logId) => logId !== id) : [...prev, id],
    );
  }

  async function loadApiList() {
    try {
      const res = await fetch("/api/apis");
      if (!res.ok) return;
      const apis = (await res.json()) as ApiConfig[];
      setApiList(apis);
      // Auto-select first API when none is selected
      setSelectedApi((prev) => (!prev && apis.length > 0 ? apis[0].apiName : prev));
    } catch {
      // non-fatal
    }
  }

  async function confirmDeleteApi() {
    if (!deleteApiName) return;
    try {
      await fetch(`/api/apis?apiName=${encodeURIComponent(deleteApiName)}`, {
        method: "DELETE",
      });
      setDeleteApiName(null);
      const wasSelected = selectedApi === deleteApiName;
      if (wasSelected) setSelectedApi("");
      await loadApiList();
      // If was selected and there are no more APIs, reset loading state
      if (wasSelected) {
        setLogs([]);
        setRoutes([]);
        setLoading(false);
        hasLoadedOnce.current = false;
      }
    } catch {
      // non-fatal
    }
  }

  function copyUrl() {
    const url = `${baseUrl}/api/${currentServerName}/${selectedApi}/*`;
    navigator.clipboard.writeText(url).then(() => {
      setUrlCopied(true);
      setTimeout(() => setUrlCopied(false), 2000);
    }).catch(() => {/* ignore */});
  }

  async function openRouteConfig(route: ApiRouteStat) {
    const isSame = configRouteId === route.id;
    if (isSame) {
      setConfigRouteId(null);
      setConfigMessage(null);
      return;
    }

    setConfigRouteId(route.id);
    setConfigMessage(null);
    setConfigStatus("200");
    setConfigBody('{"status":"ok"}');
    setConfigHeaders("{}");
    setConfigProxyUrl("");
    setConfigProxyModeType("disabled");
    setConfigProxyClientId("");
    setConfigProxyServiceName("");

    try {
      const res = await fetch(`/api/routes/configs?apiName=${encodeURIComponent(selectedApi)}`);
      if (!res.ok) throw new Error(await res.text());
      const configs = (await res.json()) as ApiRouteConfig[];
      const match = configs.find(
        (cfg) =>
          cfg.method.toUpperCase() === route.method.toUpperCase() &&
          normalizePathFront(cfg.path) === normalizePathFront(route.path),
      );
      if (match) {
        setConfigStatus(String(match.status ?? 200));
        setConfigBody(
          match.body !== undefined && match.body !== null
            ? JSON.stringify(match.body, null, 2)
            : '{"status":"ok"}',
        );
        setConfigHeaders(
          match.headers && Object.keys(match.headers).length
            ? JSON.stringify(match.headers, null, 2)
            : "{}",
        );
        if (match.proxyToClient && match.proxyClientId) {
          setConfigProxyModeType("client");
          setConfigProxyClientId(match.proxyClientId);
          setConfigProxyServiceName(match.proxyServiceName ?? "");
        } else if (match.proxyMode && match.proxyUrl) {
          setConfigProxyModeType("url");
          setConfigProxyUrl(match.proxyUrl);
        } else {
          setConfigProxyModeType("disabled");
        }
      }
    } catch (err) {
      console.error("Erro ao carregar config da rota:", err);
    }
  }

  async function openApiConfig() {
    setApiConfigOpen(true);
    setApiConfigMessage(null);
    setApiProxyModeType("disabled");
    setApiProxyUrl("");
    setApiProxyClientId("");
    setApiProxyServiceName("");

    try {
      const res = await fetch("/api/apis");
      if (!res.ok) return;
      const apis = (await res.json()) as ApiConfig[];
      const match = apis.find(
        (a) => a.apiName.toLowerCase() === selectedApi.toLowerCase(),
      );
      if (match) {
        if (match.proxyToClient && match.proxyClientId) {
          setApiProxyModeType("client");
          setApiProxyClientId(match.proxyClientId);
          setApiProxyServiceName(match.proxyServiceName ?? "");
        } else if (match.proxyMode && match.proxyUrl) {
          setApiProxyModeType("url");
          setApiProxyUrl(match.proxyUrl);
        }
      }
    } catch {
      // non-fatal
    }
  }

  async function readImportFile(file: File) {
    const raw = await file.text();
    const parsed = JSON.parse(raw);
    setImportText(JSON.stringify(parsed, null, 2));
    setImportFileName(file.name);
  }

  // Connect SSE for current api (with auto-reconnect on error)
  function connectSse(api: string) {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    sseRef.current?.close();

    const es = new EventSource(`/api/events?apiName=${encodeURIComponent(api)}`);
    sseRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as {
          type?: string;
          logs?: ApiRequestLog[];
          routes?: ApiRouteStat[];
          clients?: ProxyClientInfo[];
        };
        if (data.type === "heartbeat") return; // ignorar keepalive
        if (data.logs) setLogs(data.logs);
        if (data.routes) setRoutes(data.routes);
        if (data.clients) setConnectedClients(data.clients);
        if (data.logs || data.routes) setLoading(false);
      } catch {
        // ignore
      }
    };

    es.onerror = () => {
      console.warn("[FC-DEBUG] SSE onerror disparado para api:", api, "— reconectando em 4s");
      console.trace("[FC-DEBUG] SSE onerror stack:");
      es.close();
      // Reconecta automaticamente após 4s se ainda estiver autenticado
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        if (authenticatedRef.current) {
          connectSse(api);
        }
      }, 4000);
    };
  }

  useEffect(() => {
    let cancelled = false;
    async function loadSession() {
      try {
        const serverFromPath = getServerFromPathname(window.location.pathname);
        const res = await fetch("/api/server/session");
        if (!res.ok) throw new Error(await res.text());
        const data = (await res.json()) as {
          authenticated: boolean;
          serverName?: string;
        };
        if (cancelled) return;

        if (!data.authenticated) {
          authenticatedRef.current = false;
          try {
            sessionStorage.removeItem("fc_auth");
            sessionStorage.removeItem("fc_server");
            sessionStorage.removeItem("fc_selected_api");
            sessionStorage.removeItem("fc_active_tab");
          } catch { /* ignore */ }
          setAuthenticated(false);
          setCurrentServerName("");
          setLoginServerName(serverFromPath);
          setLoginPassword("");
          hasLoadedOnce.current = false;
          return;
        }

        const sessionServer = normalizeServerName(data.serverName ?? "");

        if (serverFromPath && serverFromPath !== sessionServer) {
          try {
            const switchRes = await fetch("/api/server/login", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ serverName: serverFromPath, password: "" }),
            });
            if (!switchRes.ok) {
              authenticatedRef.current = false;
              try {
                sessionStorage.removeItem("fc_auth");
                sessionStorage.removeItem("fc_server");
                sessionStorage.removeItem("fc_selected_api");
                sessionStorage.removeItem("fc_active_tab");
              } catch { /* ignore */ }
              setAuthenticated(false);
              setCurrentServerName("");
              setLoginServerName(serverFromPath);
              setLoginPassword("");
              setLoginError("Informe a senha para acessar este server.");
              return;
            }
            const switched = (await switchRes.json()) as {
              ok: boolean;
              serverName: string;
            };
            if (switched.ok) {
              setAuthenticated(true);
              setCurrentServerName(switched.serverName);
              setLoginServerName(switched.serverName);
              setLoginPassword("");
              setError(null);
              setLoading(true);
              return;
            }
          } catch {
            setAuthenticated(false);
            setCurrentServerName("");
            setLoginServerName(serverFromPath);
            setLoginPassword("");
            setLoginError("Não foi possível trocar de server automaticamente.");
            return;
          }
        }

        authenticatedRef.current = true;
        try { sessionStorage.setItem("fc_auth", "1"); sessionStorage.setItem("fc_server", sessionServer); } catch { /* ignore */ }
        setAuthenticated(true);
        setCurrentServerName(sessionServer);
        setLoginServerName(sessionServer);
        setLoginPassword("");
        setError(null);

        if (!serverFromPath || serverFromPath !== sessionServer) {
          window.history.replaceState({}, "", buildServerPath(sessionServer));
        }
      } catch {
        if (!cancelled) {
          setAuthenticated(false);
          setCurrentServerName("");
          const serverFromPath = getServerFromPathname(window.location.pathname);
          setLoginServerName(serverFromPath);
        }
      } finally {
        if (!cancelled) setSessionReady(true);
      }
    }
    loadSession();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load data whenever authenticated or selectedApi changes
  useEffect(() => {
    if (!authenticated) return;

    console.info("[FC-DEBUG] effect [auth,api] rodou — authenticated:", authenticated, "selectedApi:", selectedApi, "hasLoadedOnce:", hasLoadedOnce.current);

    // Detect if the user actually switched to a different API (not just an initial mount).
    const apiSwitched =
      prevSelectedApiRef.current !== null && prevSelectedApiRef.current !== selectedApi;
    if (selectedApi) prevSelectedApiRef.current = selectedApi;

    // Always refresh the API list (handles auto-select when selectedApi is empty)
    void loadApiList();

    if (!selectedApi) return; // Aguarda a seleção de uma API

    let cancelled = false;

    async function loadSnapshot(isInitial: boolean) {
      // Só bloqueia a UI na carga inicial (sem dados ainda).
      // Mudanças de API fazem refresh silencioso — mantém dados anteriores visíveis.
      if (isInitial) {
        setLoading(true);
      } else {
        setRefreshing(true);
      }
      setExpandedIds([]);
      // Only reset the route-config form when the user switches to a different API.
      // On initial mount, we preserve whatever was restored from sessionStorage.
      if (apiSwitched) {
        setConfigRouteId(null);
        try { sessionStorage.removeItem("fc_config_state"); } catch { /* ignore */ }
      }
      try {
        const [logsRes, routesRes] = await Promise.all([
          fetch(`/api/logs?apiName=${encodeURIComponent(selectedApi)}`),
          fetch(`/api/routes?apiName=${encodeURIComponent(selectedApi)}`),
        ]);
        if (!logsRes.ok) throw new Error(await logsRes.text());
        if (!routesRes.ok) throw new Error(await routesRes.text());
        const [logsData, routesData] = (await Promise.all([
          logsRes.json(),
          routesRes.json(),
        ])) as [ApiRequestLog[], ApiRouteStat[]];
        if (!cancelled) {
          setLogs(logsData);
          setRoutes(routesData);
          setError(null);
          setLoading(false);
          setRefreshing(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
          setRefreshing(false);
        }
      }
    }

    const isInitial = !hasLoadedOnce.current;
    hasLoadedOnce.current = true;
    loadSnapshot(isInitial);
    connectSse(selectedApi);

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      sseRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, selectedApi]);

  if (!sessionReady) {
    return (
      <div className="min-h-screen bg-zinc-50 font-sans text-zinc-900 dark:bg-black dark:text-zinc-50">
        <main className="mx-auto flex min-h-screen max-w-md items-center px-4">
          <div className="w-full rounded-lg border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
            <p className="text-sm text-zinc-600 dark:text-zinc-300">Carregando...</p>
          </div>
        </main>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="min-h-screen bg-zinc-50 font-sans text-zinc-900 dark:bg-black dark:text-zinc-50">
        <main className="mx-auto flex min-h-screen max-w-md items-center px-4">
          <form
            className="w-full rounded-lg border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
            onSubmit={async (e) => {
              e.preventDefault();
              setLoginError(null);
              setLoginSubmitting(true);
              try {
                const res = await fetch("/api/server/login", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    serverName: loginServerName.trim(),
                    password: loginPassword,
                  }),
                });
                if (!res.ok) throw new Error(await res.text());
                const data = (await res.json()) as {
                  ok: boolean;
                  serverName: string;
                };
                if (data.ok) {
                  authenticatedRef.current = true;
                  try { sessionStorage.setItem("fc_auth", "1"); sessionStorage.setItem("fc_server", data.serverName); } catch { /* ignore */ }
                  setAuthenticated(true);
                  setCurrentServerName(data.serverName);
                  window.history.replaceState(
                    {},
                    "",
                    buildServerPath(data.serverName),
                  );
                  setLoading(true);
                  return;
                }
                throw new Error("Falha ao autenticar.");
              } catch (err) {
                setLoginError(
                  err instanceof Error ? err.message : "Falha ao autenticar servidor.",
                );
              } finally {
                setLoginSubmitting(false);
              }
            }}
          >
            <h1 className="text-xl font-semibold tracking-tight">Freeceptor</h1>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
              Entre com o server config para acessar requests e rotas.
            </p>
            <div className="mt-4 space-y-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-zinc-500">Server name</span>
                <input
                  type="text"
                  className="h-9 rounded border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                  value={loginServerName}
                  onChange={(e) => setLoginServerName(e.target.value)}
                  placeholder="ex: antifraude"
                  required
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-zinc-500">Senha (opcional)</span>
                <input
                  type="password"
                  className="h-9 rounded border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  placeholder="Digite a senha do server"
                />
              </label>
            </div>
            {loginError && (
              <div className="mt-3 rounded-md bg-red-100 px-3 py-2 text-xs text-red-800 dark:bg-red-900/40 dark:text-red-200">
                {loginError}
              </div>
            )}
            <button
              type="submit"
              disabled={loginSubmitting}
              className="mt-4 inline-flex h-9 items-center rounded bg-zinc-900 px-4 text-sm font-medium text-zinc-50 hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              {loginSubmitting ? "Entrando..." : "Entrar"}
            </button>
          </form>
        </main>
      </div>
    );
  }

  const currentApiConfig = apiList.find(
    (a) => a.apiName.toLowerCase() === selectedApi.toLowerCase(),
  );
  const apiHasProxy =
    currentApiConfig &&
    ((currentApiConfig.proxyMode && currentApiConfig.proxyUrl) ||
      (currentApiConfig.proxyToClient &&
        currentApiConfig.proxyClientId &&
        currentApiConfig.proxyServiceName));

  return (
    <div className="min-h-screen bg-zinc-50 font-sans text-zinc-900 dark:bg-black dark:text-zinc-50">
      <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-4 px-4 py-8">
        {/* Header */}
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Freeceptor</h1>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              Server: <code className="font-mono">{currentServerName}</code>
            </p>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Toda chamada a{" "}
              <button
                type="button"
                title={urlCopied ? "Copiado!" : "Clique para copiar"}
                onClick={copyUrl}
                className={cn(
                  "inline-flex items-center gap-1 rounded px-1 font-mono text-[13px] transition-colors",
                  urlCopied
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                    : "bg-zinc-100 text-zinc-800 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700",
                )}
              >
                {baseUrl}/api/{currentServerName}/{selectedApi}/*
                {urlCopied ? (
                  <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                ) : (
                  <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                )}
              </button>{" "}
              aparece aqui em tempo real.
            </p>
          </div>
          <div className="mt-1 flex shrink-0 items-center gap-2">
            <a
              href={`/server/${currentServerName}/clients`}
              className="flex items-center gap-1.5 rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <span
                className={`h-2 w-2 rounded-full transition-colors ${
                  connectedClients.some((c) => c.status === "online")
                    ? "bg-emerald-500"
                    : "bg-zinc-400"
                }`}
              />
              Clientes
            </a>
            <button
              type="button"
              title="Sair do servidor"
              aria-label="Sair do servidor"
              onClick={async () => {
                try {
                  await fetch("/api/server/logout", { method: "POST" });
                } catch {
                  // ignore
                } finally {
                  authenticatedRef.current = false;
                  try {
                    sessionStorage.removeItem("fc_auth");
                    sessionStorage.removeItem("fc_server");
                    sessionStorage.removeItem("fc_selected_api");
                    sessionStorage.removeItem("fc_active_tab");
                    sessionStorage.removeItem("fc_config_state");
                  } catch {
                    // ignore
                  }
                  hasLoadedOnce.current = false;
                  setAuthenticated(false);
                  setCurrentServerName("");
                  setSelectedApi("");
                  setApiList([]);
                  setLogs([]);
                  setRoutes([]);
                  sseRef.current?.close();
                }
              }}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-zinc-300 bg-white text-zinc-500 transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:border-red-800 dark:hover:bg-red-950/40 dark:hover:text-red-400"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </button>
          </div>
        </header>

        {/* API Selector */}
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">API:</span>

          {apiList.length === 0 && !showNewApiInput && (
            <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
              Nenhuma API criada
            </span>
          )}

          {/* APIs from apiList */}
          {apiList.map((api) => (
            <div key={api.apiName} className="group relative inline-flex items-center">
              <button
                type="button"
                onClick={() => setSelectedApi(api.apiName)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full py-1 pl-2.5 pr-6 text-[11px] font-medium transition-colors",
                  selectedApi === api.apiName
                    ? "bg-zinc-900 text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                    : "border border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800",
                )}
              >
                {api.apiName}
                {(api.proxyMode || api.proxyToClient) && (
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-500" />
                )}
              </button>
              <button
                type="button"
                aria-label={`Deletar API ${api.apiName}`}
                onClick={(e) => { e.stopPropagation(); setDeleteApiName(api.apiName); }}
                className={cn(
                  "absolute right-1 flex h-4 w-4 items-center justify-center rounded-full text-[9px] transition-colors",
                  selectedApi === api.apiName
                    ? "text-zinc-400 hover:bg-zinc-700 hover:text-zinc-50 dark:text-zinc-600 dark:hover:bg-zinc-200 dark:hover:text-zinc-900"
                    : "text-zinc-400 hover:bg-red-100 hover:text-red-600 dark:text-zinc-600 dark:hover:bg-red-900/40 dark:hover:text-red-400",
                )}
              >
                ✕
              </button>
            </div>
          ))}

          {/* Add new API */}
          {showNewApiInput ? (
            <form
              className="flex items-center gap-1"
              onSubmit={async (e) => {
                e.preventDefault();
                const name = newApiName.trim().toLowerCase();
                if (!name) return;
                await fetch("/api/apis", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ apiName: name }),
                });
                await loadApiList();
                setSelectedApi(name);
                setNewApiName("");
                setShowNewApiInput(false);
              }}
            >
              <input
                autoFocus
                type="text"
                placeholder="nome-da-api"
                className="h-6 rounded border border-zinc-300 bg-white px-2 font-mono text-[11px] text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                value={newApiName}
                onChange={(e) => setNewApiName(e.target.value)}
              />
              <button
                type="submit"
                className="rounded bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
              >
                +
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowNewApiInput(false);
                  setNewApiName("");
                }}
                className="text-[11px] text-zinc-500 hover:text-zinc-700"
              >
                ✕
              </button>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setShowNewApiInput(true)}
              className="inline-flex items-center rounded-full border border-dashed border-zinc-300 px-2.5 py-1 text-[11px] font-medium text-zinc-400 transition-colors hover:border-zinc-400 hover:text-zinc-600 dark:border-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-300"
            >
              + Nova API
            </button>
          )}

          {/* API-level proxy config button */}
          <div className="ml-auto">
            <button
              type="button"
              onClick={openApiConfig}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
                apiHasProxy
                  ? "bg-blue-600 text-white dark:bg-blue-500 dark:text-zinc-950"
                  : "border border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800",
              )}
            >
              {apiHasProxy ? "Proxy da API ativo" : "Configurar proxy da API"}
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-md bg-red-100 px-3 py-2 text-sm text-red-800 dark:bg-red-900/40 dark:text-red-200">
            Erro ao carregar: {error}
          </div>
        )}

        {/* API-level proxy info banner */}
        {apiHasProxy && (
          <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-[11px] text-blue-900 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200">
            <span className="font-semibold">Proxy da API &quot;{selectedApi}&quot; ativo</span>
            {currentApiConfig?.proxyMode && currentApiConfig.proxyUrl && (
              <span> → URL: <code className="font-mono">{currentApiConfig.proxyUrl}</code></span>
            )}
            {currentApiConfig?.proxyToClient && currentApiConfig.proxyClientId && (
              <span>
                {" "}→ Cliente:{" "}
                <code className="font-mono">{currentApiConfig.proxyClientId}</code>
                {currentApiConfig.proxyServiceName && (
                  <span> / {currentApiConfig.proxyServiceName}</span>
                )}
              </span>
            )}
            <span className="ml-2 text-blue-700 dark:text-blue-400">
              (rotas com proxy próprio têm prioridade)
            </span>
          </div>
        )}

        {/* Tab bar: Requests / Routes tabs + context actions */}
        <div className="flex items-center justify-between gap-3">
          <div className="inline-flex rounded-full border border-zinc-300 bg-zinc-100 p-1 text-xs font-medium dark:border-zinc-700 dark:bg-zinc-900">
            <button
              type="button"
              onClick={() => setActiveTab("requests")}
              className={`rounded-full px-3 py-1 transition-colors ${
                activeTab === "requests"
                  ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-50"
                  : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"
              }`}
            >
              Requests
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("routes")}
              className={`rounded-full px-3 py-1 transition-colors ${
                activeTab === "routes"
                  ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-50"
                  : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"
              }`}
            >
              Rotas
            </button>
          </div>

          <div className="flex items-center gap-2">
            {activeTab === "routes" && (
              <>
                <div className="group relative">
                  <button
                    type="button"
                    aria-label="Exportar configurações de rotas"
                    className="flex h-8 w-8 items-center justify-center rounded-full border border-zinc-300 bg-white text-[13px] text-zinc-700 shadow-sm transition-all duration-150 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
                    onClick={async () => {
                      try {
                        const res = await fetch(
                          `/api/routes/configs?apiName=${encodeURIComponent(selectedApi)}`,
                        );
                        if (!res.ok) throw new Error(await res.text());
                        const configs = (await res.json()) as ApiRouteConfig[];
                        const blob = new Blob([JSON.stringify(configs, null, 2)], {
                          type: "application/json",
                        });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
                        a.download = `freeceptor-${selectedApi}-configs-${timestamp}.json`;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        URL.revokeObjectURL(url);
                      } catch (err) {
                        console.error("Erro ao exportar configs:", err);
                      }
                    }}
                  >
                    ↓
                  </button>
                  <span className="pointer-events-none absolute -bottom-7 left-1/2 -translate-x-1/2 rounded bg-zinc-900 px-2 py-0.5 text-[10px] text-zinc-50 opacity-0 shadow-sm transition-opacity duration-100 group-hover:opacity-100 dark:bg-zinc-100 dark:text-zinc-900">
                    Exportar
                  </span>
                </div>
                <div className="group relative">
                  <button
                    type="button"
                    aria-label="Importar configurações de rotas"
                    className="flex h-8 w-8 items-center justify-center rounded-full border border-zinc-300 bg-white text-[13px] text-zinc-700 shadow-sm transition-all duration-150 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
                    onClick={() => {
                      setImportError(null);
                      setImportText("");
                      setImportFileName(null);
                      setImportOpen(true);
                    }}
                  >
                    ↑
                  </button>
                  <span className="pointer-events-none absolute -bottom-7 left-1/2 -translate-x-1/2 rounded bg-zinc-900 px-2 py-0.5 text-[10px] text-zinc-50 opacity-0 shadow-sm transition-opacity duration-100 group-hover:opacity-100 dark:bg-zinc-100 dark:text-zinc-900">
                    Importar
                  </span>
                </div>
              </>
            )}
            {activeTab === "requests" && (
              <div className="group relative">
                <button
                  type="button"
                  aria-label="Limpar requisições"
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-zinc-300 bg-white text-[13px] text-zinc-700 shadow-sm transition-colors hover:bg-red-50 hover:text-red-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-red-900/40 dark:hover:text-red-200"
                  onClick={async () => {
                    try {
                      await fetch(`/api/logs?apiName=${encodeURIComponent(selectedApi)}`, {
                        method: "DELETE",
                      });
                      setLogs([]);
                      setExpandedIds([]);
                    } catch (err) {
                      console.error("Erro ao limpar requisições:", err);
                    }
                  }}
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" /><path d="M10 10v7" /><path d="M14 10v7" />
                  </svg>
                </button>
                <span className="pointer-events-none absolute -bottom-7 left-1/2 -translate-x-1/2 rounded bg-zinc-900 px-2 py-0.5 text-[10px] text-zinc-50 opacity-0 shadow-sm transition-opacity duration-100 group-hover:opacity-100 dark:bg-zinc-100 dark:text-zinc-900">
                  Limpar requisições
                </span>
              </div>
            )}
            {refreshing && !loading && (
              <span className="h-4 w-4 animate-spin rounded-full border border-zinc-400 border-t-transparent dark:border-zinc-500" />
            )}
          </div>
        </div>

        {/* Main content */}
        <section className="flex-1 overflow-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          {!selectedApi ? (
            <div className="flex flex-col items-center justify-center gap-4 px-4 py-16 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full border border-dashed border-zinc-300 text-2xl text-zinc-400 dark:border-zinc-700">
                +
              </div>
              <div>
                <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  Nenhuma API criada ainda
                </p>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  Crie uma API para começar a interceptar chamadas neste server.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowNewApiInput(true)}
                className="inline-flex items-center rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                + Criar primeira API
              </button>
            </div>
          ) : (
          <>
          <div className="border-b border-zinc-200 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            {activeTab === "requests"
              ? loading
                ? "Carregando requisições..."
                : `${logs.length} requisições registradas (mostrando as mais recentes primeiro)`
              : loading
                ? "Carregando rotas..."
                : `${routes.length} combinações método + path`}
          </div>

          <div className="max-h-[70vh] overflow-auto text-xs">
            {activeTab === "requests" ? (
              <div className="space-y-3 p-3">
                {logs.map((log) => (
                  <div
                    key={log.id}
                    className="rounded-md border border-zinc-200 bg-white shadow-sm transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900/60"
                  >
                    <div
                      className="grid cursor-pointer grid-cols-[auto_auto_1fr_auto] items-center gap-3 px-3 py-2"
                      onClick={() => toggleLogExpanded(log.id)}
                    >
                      <span className="font-mono text-[11px]">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </span>
                      <span
                        className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold"
                        style={{
                          backgroundColor:
                            log.method === "GET"
                              ? "rgba(59,130,246,0.1)"
                              : log.method === "POST"
                                ? "rgba(16,185,129,0.1)"
                                : "rgba(148,163,184,0.1)",
                          color:
                            log.method === "GET"
                              ? "#1d4ed8"
                              : log.method === "POST"
                                ? "#047857"
                                : "#334155",
                        }}
                      >
                        {log.method}
                      </span>
                      <span className="inline-flex items-center gap-2 font-mono text-[11px]">
                        <span>{log.path || "-"}</span>
                        {log.proxyTargetUrl && (
                          <span className="ml-2 inline-flex items-center rounded-full bg-blue-600 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white dark:bg-blue-500 dark:text-zinc-950">
                            proxy url
                          </span>
                        )}
                        {log.proxyClientId && (
                          <span className="ml-2 inline-flex items-center rounded-full bg-violet-600 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white dark:bg-violet-500 dark:text-zinc-950">
                            proxy client
                          </span>
                        )}
                      </span>
                      {!expandedIds.includes(log.id) && (
                        <span
                          className={cn(
                            "inline-flex min-w-12 items-center justify-center rounded-full px-2.5 py-1 font-mono text-[12px] font-semibold",
                            statusPillClass(log.responseStatus),
                          )}
                        >
                          {log.responseStatus}
                        </span>
                      )}
                    </div>

                    {expandedIds.includes(log.id) && (
                      <div className="border-t border-zinc-100 bg-zinc-50 px-3 py-3 text-[11px] text-zinc-700 dark:border-zinc-900 dark:bg-zinc-900 dark:text-zinc-200">
                        <div className="mb-3 flex gap-3">
                          <div className="flex w-6 shrink-0 flex-col items-center pt-0.5">
                            <div className="flex h-5 w-5 items-center justify-center rounded-full border border-zinc-300 bg-white text-[10px] text-zinc-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200">
                              <span className="block leading-none">→</span>
                            </div>
                            <div className="mt-1 w-px flex-1 bg-zinc-300 dark:bg-zinc-700" />
                          </div>
                          <div className="flex-1">
                            <div className="mb-2 flex min-h-5 items-center justify-between">
                              <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                                Dados da request
                              </div>
                            </div>
                            <div className="grid gap-3 md:grid-cols-2">
                              <div>
                                <div className="mb-1 text-[11px] font-medium text-zinc-500">
                                  Query Params
                                </div>
                                {renderKeyValueTable(log.queryParams ?? {})}
                              </div>
                              <div>
                                <div className="mb-1 text-[11px] font-medium text-zinc-500">
                                  Headers
                                </div>
                                {renderKeyValueTable(log.headers ?? {})}
                              </div>
                            </div>
                            <div className="mt-3">
                              <div className="mb-1 text-[11px] font-medium text-zinc-500">
                                Body
                              </div>
                              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded border border-zinc-200 bg-white px-2 py-1 font-mono text-[11px] text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100">
                                {log.body != null && log.body !== ""
                                  ? JSON.stringify(log.body, null, 2)
                                  : "(sem body)"}
                              </pre>
                            </div>
                          </div>
                        </div>
                        <div className="mt-3 border-t border-dashed border-zinc-200 pt-3 text-[11px] dark:border-zinc-700">
                          <div className="mb-3 flex gap-3">
                            <div className="flex w-6 shrink-0 flex-col items-center pt-0.5">
                              <div className="flex h-5 w-5 items-center justify-center rounded-full border border-zinc-300 bg-white text-[10px] text-zinc-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200">
                                <span className="block leading-none">←</span>
                              </div>
                              <div className="mt-1 w-px flex-1 bg-zinc-300 dark:bg-zinc-700" />
                            </div>
                            <div className="flex-1">
                              <div className="mb-2 flex min-h-5 items-center justify-between gap-2">
                                <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                                  Dados da resposta
                                </div>
                                <span
                                  className={cn(
                                    "inline-flex min-w-12 items-center justify-center rounded-full px-2.5 py-1 font-mono text-[12px] font-semibold",
                                    statusPillClass(log.responseStatus),
                                  )}
                                >
                                  {log.responseStatus}
                                </span>
                              </div>
                              {log.proxyTargetUrl && (
                                <div className="mb-2 rounded border border-blue-200 bg-blue-50 px-2 py-1.5 text-[11px] text-blue-900 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200">
                                  <div>
                                    <span className="font-semibold">Proxy URL habilitado</span>
                                    <span>, respondido por:</span>
                                  </div>
                                  <div className="mt-2 break-all font-mono text-[11px] font-semibold">
                                    {log.proxyResolvedUrl ?? log.proxyTargetUrl}
                                  </div>
                                </div>
                              )}
                              {log.proxyClientId && (
                                <div className="mb-2 rounded border border-violet-200 bg-violet-50 px-2 py-1.5 text-[11px] text-violet-900 dark:border-violet-900/60 dark:bg-violet-950/30 dark:text-violet-200">
                                  <div>
                                    <span className="font-semibold">Proxy Client habilitado</span>
                                    <span>, respondido pelo cliente:</span>
                                  </div>
                                  <div className="mt-2 flex items-center gap-2">
                                    <span className="rounded bg-violet-200 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-violet-800 dark:bg-violet-800 dark:text-violet-200">
                                      {log.proxyClientName || log.proxyClientId}
                                    </span>
                                    <span className="text-violet-600 dark:text-violet-400">→</span>
                                    <span className="font-mono text-[11px]">
                                      {log.proxyServiceName}
                                    </span>
                                  </div>
                                </div>
                              )}
                              <div className="grid gap-3 md:grid-cols-2">
                                <div>
                                  <div className="mb-1 text-[11px] text-zinc-500">
                                    Body (response)
                                  </div>
                                  <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded border border-zinc-200 bg-white px-2 py-1 font-mono text-[11px] text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100">
                                    {log.responseBody != null && log.responseBody !== ""
                                      ? JSON.stringify(log.responseBody, null, 2)
                                      : "(sem body)"}
                                  </pre>
                                </div>
                                <div>
                                  <div className="mb-1 text-[11px] text-zinc-500">
                                    Headers (response)
                                  </div>
                                  <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded border border-zinc-200 bg-white px-2 py-1 font-mono text-[11px] text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100">
                                    {log.responseHeaders &&
                                    Object.keys(log.responseHeaders).length
                                      ? JSON.stringify(log.responseHeaders, null, 2)
                                      : "(sem headers)"}
                                  </pre>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}

                {!loading && logs.length === 0 && (
                  <div className="rounded border border-dashed border-zinc-300 px-3 py-6 text-center text-xs text-zinc-500 dark:border-zinc-700">
                    Nenhuma requisição registrada ainda. Faça um{" "}
                    <code className="mx-1 rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px] dark:bg-zinc-900">
                      GET /api/{currentServerName}/{selectedApi}/qualquer/coisa
                    </code>{" "}
                    e veja aparecer aqui.
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-3 p-3">
                {routes.map((route) => (
                  <div
                    key={route.id}
                    className="rounded-md border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
                  >
                    <div
                      className="grid cursor-pointer grid-cols-[auto_1fr_auto_auto_auto] items-center gap-3 px-3 py-2"
                      onClick={() => {
                        void openRouteConfig(route);
                      }}
                    >
                      <span
                        className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold"
                        style={{
                          backgroundColor:
                            route.method === "GET"
                              ? "rgba(59,130,246,0.1)"
                              : route.method === "POST"
                                ? "rgba(16,185,129,0.1)"
                                : "rgba(148,163,184,0.1)",
                          color:
                            route.method === "GET"
                              ? "#1d4ed8"
                              : route.method === "POST"
                                ? "#047857"
                                : "#334155",
                        }}
                      >
                        {route.method}
                      </span>
                      <span className="font-mono text-[11px]">
                        {route.path
                          .split("/")
                          .filter(Boolean)
                          .join(" / ") || "-"}
                      </span>
                      <span className="text-[11px] text-zinc-600 dark:text-zinc-300">
                        chamadas: {route.count}
                      </span>
                      <span className="font-mono text-[11px] text-zinc-600 dark:text-zinc-300">
                        {route.lastTimestamp
                          ? new Date(route.lastTimestamp).toLocaleTimeString()
                          : "-"}
                      </span>
                      <div className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          aria-label="Remover configuração desta rota"
                          className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-zinc-300 text-[11px] text-zinc-600 hover:bg-red-50 hover:text-red-700 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-red-900/40 dark:hover:text-red-200"
                          onClick={async (e) => {
                            e.stopPropagation();
                            try {
                              const res = await fetch("/api/routes", {
                                method: "DELETE",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                  apiName: selectedApi,
                                  method: route.method,
                                  path: route.path,
                                }),
                              });

                              if (!res.ok) {
                                const text = await res.text();
                                throw new Error(text);
                              }

                              const payload = (await res.json()) as { ok: boolean };
                              setConfigRouteId(route.id);
                              setConfigStatus("200");
                              setConfigBody('{"status":"ok"}');
                              setConfigHeaders("{}");
                              setConfigProxyModeType("disabled");
                              setConfigProxyUrl("");
                              setConfigMessage(
                                payload.ok
                                  ? "Configuração removida com sucesso."
                                  : "Essa rota não possui configuração salva.",
                              );
                            } catch (err) {
                              setConfigRouteId(route.id);
                              setConfigMessage(
                                err instanceof Error
                                  ? `Erro ao remover configuração: ${err.message}`
                                  : "Erro ao remover configuração",
                              );
                            }
                          }}
                        >
                          <svg
                            viewBox="0 0 24 24"
                            className="h-3.5 w-3.5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M3 6h18" />
                            <path d="M8 6V4h8v2" />
                            <path d="M6 6l1 14h10l1-14" />
                            <path d="M10 10v7" />
                            <path d="M14 10v7" />
                          </svg>
                        </button>
                      </div>
                    </div>

                    {configRouteId === route.id && (
                      <div className="border-t border-zinc-100 bg-zinc-50 px-3 py-3 text-[11px] text-zinc-700 dark:border-zinc-900 dark:bg-zinc-900 dark:text-zinc-200">
                        {apiHasProxy && (
                          <div className="mb-3 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                            Esta API tem proxy configurado. Configurar proxy aqui na rota irá <strong>sobrescrever</strong> o proxy da API para esta rota específica.
                          </div>
                        )}
                        <form
                          className="flex flex-col gap-2"
                          onSubmit={async (e) => {
                            e.preventDefault();
                            setConfigMessage(null);
                            try {
                              if (configProxyModeType === "url" && !configProxyUrl.trim()) {
                                throw new Error("Informe a URL do proxy.");
                              }
                              if (configProxyModeType === "client") {
                                if (!configProxyClientId) {
                                  throw new Error("Selecione um cliente conectado.");
                                }
                                if (!configProxyServiceName) {
                                  throw new Error("Selecione um serviço do cliente.");
                                }
                              }

                              const statusNumber = Number(configStatus) || 200;
                              const parsedBody = configBody ? JSON.parse(configBody) : null;
                              const parsedHeaders = configHeaders
                                ? JSON.parse(configHeaders)
                                : {};

                              const res = await fetch("/api/routes", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                  apiName: selectedApi,
                                  method: route.method,
                                  path: route.path,
                                  status: statusNumber,
                                  headers: parsedHeaders,
                                  responseBody: parsedBody,
                                  proxyMode: configProxyModeType === "url",
                                  proxyUrl: configProxyModeType === "url" ? configProxyUrl.trim() : "",
                                  proxyToClient: configProxyModeType === "client",
                                  proxyClientId:
                                    configProxyModeType === "client" ? configProxyClientId : "",
                                  proxyServiceName:
                                    configProxyModeType === "client"
                                      ? configProxyServiceName
                                      : "",
                                }),
                              });

                              if (!res.ok) {
                                const text = await res.text();
                                throw new Error(text);
                              }

                              setConfigMessage(
                                "Configuração salva. As próximas chamadas dessa rota usarão essa resposta.",
                              );
                            } catch (err) {
                              setConfigMessage(
                                err instanceof Error
                                  ? `Erro ao salvar configuração: ${err.message}`
                                  : "Erro ao salvar configuração",
                              );
                            }
                          }}
                        >
                          <div className="mb-2">
                            <span className="mb-1 block text-[11px] font-medium text-zinc-500">
                              Modo de resposta
                            </span>
                            <div className="flex flex-wrap gap-3">
                              <label className="inline-flex items-center gap-1.5 text-[11px]">
                                <input
                                  type="radio"
                                  name="proxyModeType"
                                  className="h-3.5 w-3.5"
                                  checked={configProxyModeType === "disabled"}
                                  onChange={() => setConfigProxyModeType("disabled")}
                                />
                                <span>Resposta mock</span>
                              </label>
                              <label className="inline-flex items-center gap-1.5 text-[11px]">
                                <input
                                  type="radio"
                                  name="proxyModeType"
                                  className="h-3.5 w-3.5"
                                  checked={configProxyModeType === "url"}
                                  onChange={() => setConfigProxyModeType("url")}
                                />
                                <span>Proxy para URL</span>
                              </label>
                              <label className="inline-flex items-center gap-1.5 text-[11px]">
                                <input
                                  type="radio"
                                  name="proxyModeType"
                                  className="h-3.5 w-3.5"
                                  checked={configProxyModeType === "client"}
                                  onChange={() => setConfigProxyModeType("client")}
                                />
                                <span>Proxy para cliente (ngrok-style)</span>
                              </label>
                            </div>
                          </div>

                          {configProxyModeType === "url" && (
                            <div className="mb-2 rounded border border-blue-200 bg-blue-50 p-2 dark:border-blue-900 dark:bg-blue-950/30">
                              <label className="flex flex-col gap-1">
                                <span className="text-[11px] font-medium text-blue-700 dark:text-blue-300">
                                  URL de destino
                                </span>
                                <input
                                  type="url"
                                  placeholder="https://api.exemplo.com/endpoint"
                                  className="h-7 rounded border border-zinc-300 bg-white px-2 font-mono text-[11px] text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                                  value={configProxyUrl}
                                  onChange={(e) => setConfigProxyUrl(e.target.value)}
                                />
                              </label>
                            </div>
                          )}

                          {configProxyModeType === "client" && (
                            <div className="mb-2 rounded border border-violet-200 bg-violet-50 p-2 dark:border-violet-900 dark:bg-violet-950/30">
                              <div className="mb-1 flex items-center gap-1">
                                <span className="text-[11px] font-medium text-violet-700 dark:text-violet-300">
                                  Cliente conectado
                                </span>
                                <span className="rounded bg-violet-200 px-1 py-0.5 text-[9px] font-medium text-violet-800 dark:bg-violet-800 dark:text-violet-200">
                                  ngrok-style
                                </span>
                              </div>
                              {connectedClients.filter((c) => c.status === "online").length ===
                              0 ? (
                                <div className="rounded bg-amber-100 px-2 py-1.5 text-[11px] text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
                                  Nenhum cliente online. Inicie um proxy-reverse agent.
                                </div>
                              ) : (
                                <div className="grid gap-2 sm:grid-cols-2">
                                  <label className="flex flex-col gap-1">
                                    <span className="text-[10px] text-violet-600 dark:text-violet-400">
                                      Cliente
                                    </span>
                                    <select
                                      className="h-7 rounded border border-zinc-300 bg-white px-2 text-[11px] dark:border-zinc-700 dark:bg-zinc-950"
                                      value={configProxyClientId}
                                      onChange={(e) => {
                                        setConfigProxyClientId(e.target.value);
                                        setConfigProxyServiceName("");
                                      }}
                                    >
                                      <option value="">Selecione um cliente</option>
                                      {connectedClients
                                        .filter((c) => c.status === "online")
                                        .map((client) => (
                                          <option
                                            key={client.clientId}
                                            value={client.clientId}
                                          >
                                            {client.clientName} (
                                            {client.localServices.length} serviços)
                                          </option>
                                        ))}
                                    </select>
                                  </label>
                                  <label className="flex flex-col gap-1">
                                    <span className="text-[10px] text-violet-600 dark:text-violet-400">
                                      Serviço
                                    </span>
                                    <select
                                      className="h-7 rounded border border-zinc-300 bg-white px-2 text-[11px] dark:border-zinc-700 dark:bg-zinc-950"
                                      value={configProxyServiceName}
                                      onChange={(e) =>
                                        setConfigProxyServiceName(e.target.value)
                                      }
                                      disabled={!configProxyClientId}
                                    >
                                      <option value="">Selecione um serviço</option>
                                      {connectedClients
                                        .find((c) => c.clientId === configProxyClientId)
                                        ?.localServices.map((service) => (
                                          <option key={service.name} value={service.name}>
                                            {service.name} ({service.host}:{service.port})
                                          </option>
                                        ))}
                                    </select>
                                  </label>
                                </div>
                              )}
                            </div>
                          )}

                          <div
                            className={cn(
                              "flex flex-wrap gap-2 transition-opacity",
                              configProxyModeType !== "disabled" && "opacity-50",
                            )}
                          >
                            <label className="flex items-center gap-1 text-[11px]">
                              <span className="text-zinc-500">Status</span>
                              <input
                                type="number"
                                min={100}
                                max={599}
                                className="h-6 w-16 rounded border border-zinc-300 bg-white px-1 font-mono text-[11px] text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                                value={configStatus}
                                onChange={(e) => setConfigStatus(e.target.value)}
                                disabled={configProxyModeType !== "disabled"}
                              />
                            </label>
                          </div>
                          <div
                            className={cn(
                              "grid gap-2 md:grid-cols-2 transition-opacity",
                              configProxyModeType !== "disabled" && "opacity-50",
                            )}
                          >
                            <label className="flex flex-col gap-1">
                              <span className="text-[11px] text-zinc-500">Body (JSON)</span>
                              <textarea
                                rows={6}
                                className="w-full rounded border border-zinc-300 bg-white px-2 py-1 font-mono text-[11px] text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                                value={configBody}
                                onChange={(e) => setConfigBody(e.target.value)}
                                disabled={configProxyModeType !== "disabled"}
                              />
                            </label>
                            <div className="flex flex-col gap-1">
                              <label className="flex flex-col gap-1">
                                <span className="text-[11px] text-zinc-500">
                                  Cabeçalhos (JSON)
                                </span>
                                <textarea
                                  rows={4}
                                  className="w-full rounded border border-zinc-300 bg-white px-2 py-1 font-mono text-[11px] text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                                  value={configHeaders}
                                  onChange={(e) => setConfigHeaders(e.target.value)}
                                  disabled={configProxyModeType !== "disabled"}
                                />
                              </label>
                              <div>
                                <span className="mb-1 block text-[11px] text-zinc-500">
                                  Cabeçalhos (tabela)
                                </span>
                                {renderKeyValueTable(
                                  toStringRecord(safeParseJson(configHeaders || "{}")),
                                )}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <button
                              type="submit"
                              className="inline-flex items-center rounded bg-zinc-900 px-3 py-1 text-[11px] font-medium text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                            >
                              Salvar configuração
                            </button>
                            {configMessage && (
                              <span className="text-[11px] text-zinc-500">
                                {configMessage}
                              </span>
                            )}
                          </div>
                        </form>
                      </div>
                    )}
                  </div>
                ))}
                {!loading && routes.length === 0 && (
                  <div className="rounded border border-dashed border-zinc-300 px-3 py-6 text-center text-xs text-zinc-500 dark:border-zinc-700">
                    Nenhuma rota registrada ainda. Faça uma chamada para{" "}
                    <code className="mx-1 rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px] dark:bg-zinc-900">
                      /api/{currentServerName}/{selectedApi}/alguma/coisa
                    </code>{" "}
                    e veja aparecer aqui.
                  </div>
                )}
              </div>
            )}
          </div>
          </>
          )}
        </section>
      </main>

      {/* Delete API confirmation modal */}
      {deleteApiName && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-lg dark:bg-zinc-950">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
              Deletar API &quot;{deleteApiName}&quot;?
            </h2>
            <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
              Todas as configurações de proxy e rotas associadas a esta API serão removidas
              permanentemente. Esta ação não pode ser desfeita.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteApiName(null)}
                className="rounded border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void confirmDeleteApi()}
                className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600"
              >
                Deletar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import modal */}
      {importOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-xl rounded-lg bg-white p-4 shadow-lg dark:bg-zinc-950">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                  Importar configurações de rotas — API: {selectedApi}
                </h2>
                <p className="text-xs text-zinc-600 dark:text-zinc-400">
                  Arraste um arquivo{" "}
                  <code className="mx-1 rounded bg-zinc-100 px-1 py-[1px] font-mono text-[10px] dark:bg-zinc-900">
                    .json
                  </code>{" "}
                  ou procure no computador.
                </p>
              </div>
              <button
                type="button"
                className="rounded-full p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-900"
                onClick={() => {
                  if (!importing) setImportOpen(false);
                }}
              >
                ✕
              </button>
            </div>

            <div className="mb-3 grid gap-3 md:grid-cols-2">
              <div
                className="flex h-56 cursor-default flex-col items-center justify-center rounded-md border border-dashed border-zinc-300 bg-zinc-50 px-3 py-2 text-center text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                onDragOver={(e) => e.preventDefault()}
                onDrop={async (e) => {
                  e.preventDefault();
                  try {
                    setImportError(null);
                    if (e.dataTransfer.files?.[0]) {
                      await readImportFile(e.dataTransfer.files[0]);
                    }
                  } catch {
                    setImportError("Arquivo inválido. Envie um JSON válido.");
                  }
                }}
              >
                <span className="mb-2 text-2xl leading-none">↑</span>
                <span className="text-[11px] font-medium">
                  Arraste um arquivo aqui
                </span>
              </div>
              <button
                type="button"
                className="flex h-56 cursor-pointer flex-col items-center justify-center rounded-md border border-dashed border-zinc-300 bg-zinc-50 px-3 py-2 text-center text-xs text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
                onClick={() => importFileInputRef.current?.click()}
              >
                <span className="mb-2 text-2xl leading-none">⌕</span>
                <span className="text-[11px] font-medium">
                  Clique para selecionar do computador
                </span>
              </button>
              <input
                ref={importFileInputRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={async (e) => {
                  try {
                    setImportError(null);
                    const file = e.target.files?.[0];
                    if (!file) return;
                    await readImportFile(file);
                  } catch {
                    setImportError("Arquivo inválido.");
                  } finally {
                    if (importFileInputRef.current) {
                      importFileInputRef.current.value = "";
                    }
                  }
                }}
              />
            </div>

            {importFileName && (
              <div className="mb-2 rounded-md bg-zinc-100 px-3 py-1.5 text-xs text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
                Arquivo: <span className="font-mono">{importFileName}</span>
              </div>
            )}

            {importError && (
              <div className="mb-2 rounded-md bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-200">
                {importError}
              </div>
            )}

            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-zinc-500">
                As rotas importadas serão mescladas às existentes.
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="rounded border border-zinc-300 px-3 py-1 text-[11px] text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
                  onClick={() => {
                    if (!importing) setImportOpen(false);
                  }}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="inline-flex items-center rounded bg-zinc-900 px-3 py-1 text-[11px] font-medium text-zinc-50 hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                  disabled={importing}
                  onClick={async () => {
                    try {
                      setImportError(null);
                      setImporting(true);
                      if (!importText.trim()) {
                        throw new Error("Selecione um arquivo JSON primeiro.");
                      }
                      const parsed = JSON.parse(importText) as
                        | ApiRouteConfig[]
                        | ApiRouteConfig;
                      const configs = Array.isArray(parsed) ? parsed : [parsed];
                      for (const cfg of configs) {
                        if (!cfg.method || !cfg.path) {
                          throw new Error(
                            "JSON inválido: cada item precisa de method e path.",
                          );
                        }
                        const res = await fetch("/api/routes", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            apiName: selectedApi,
                            method: cfg.method,
                            path: cfg.path,
                            status: cfg.status,
                            headers: cfg.headers ?? {},
                            responseBody: cfg.body ?? null,
                            proxyMode: Boolean(cfg.proxyMode),
                            proxyUrl: cfg.proxyUrl ?? "",
                            proxyToClient: Boolean(cfg.proxyToClient),
                            proxyClientId: cfg.proxyClientId ?? "",
                            proxyServiceName: cfg.proxyServiceName ?? "",
                          }),
                        });
                        if (!res.ok) {
                          const text = await res.text();
                          throw new Error(
                            `Falha ao importar rota ${cfg.method} ${cfg.path}: ${text}`,
                          );
                        }
                      }
                      setImportOpen(false);
                    } catch (err) {
                      setImportError(
                        err instanceof Error ? err.message : "Erro ao importar configs.",
                      );
                    } finally {
                      setImporting(false);
                    }
                  }}
                >
                  {importing ? "Importando..." : "Importar"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* API proxy config modal */}
      {apiConfigOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-lg rounded-lg bg-white p-4 shadow-lg dark:bg-zinc-950">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                  Proxy da API &quot;{selectedApi}&quot;
                </h2>
                <p className="text-xs text-zinc-600 dark:text-zinc-400">
                  Configurado aqui, aplica-se a todas as rotas desta API. Rotas com proxy próprio têm prioridade.
                </p>
              </div>
              <button
                type="button"
                className="rounded-full p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-900"
                onClick={() => setApiConfigOpen(false)}
              >
                ✕
              </button>
            </div>

            <form
              className="flex flex-col gap-3"
              onSubmit={async (e) => {
                e.preventDefault();
                setApiConfigMessage(null);
                setApiConfigSaving(true);
                try {
                  if (apiProxyModeType === "url" && !apiProxyUrl.trim()) {
                    throw new Error("Informe a URL do proxy.");
                  }
                  if (apiProxyModeType === "client") {
                    if (!apiProxyClientId) throw new Error("Selecione um cliente.");
                    if (!apiProxyServiceName) throw new Error("Selecione um serviço.");
                  }

                  const res = await fetch("/api/apis", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      apiName: selectedApi,
                      proxyMode: apiProxyModeType === "url",
                      proxyUrl: apiProxyModeType === "url" ? apiProxyUrl.trim() : "",
                      proxyToClient: apiProxyModeType === "client",
                      proxyClientId:
                        apiProxyModeType === "client" ? apiProxyClientId : "",
                      proxyServiceName:
                        apiProxyModeType === "client" ? apiProxyServiceName : "",
                    }),
                  });
                  if (!res.ok) throw new Error(await res.text());

                  await loadApiList();
                  setApiConfigMessage("Configuração salva.");
                } catch (err) {
                  setApiConfigMessage(
                    err instanceof Error
                      ? `Erro: ${err.message}`
                      : "Erro ao salvar.",
                  );
                } finally {
                  setApiConfigSaving(false);
                }
              }}
            >
              <div>
                <span className="mb-1 block text-[11px] font-medium text-zinc-500">
                  Modo de proxy
                </span>
                <div className="flex flex-wrap gap-3">
                  <label className="inline-flex items-center gap-1.5 text-[11px]">
                    <input
                      type="radio"
                      name="apiProxyMode"
                      className="h-3.5 w-3.5"
                      checked={apiProxyModeType === "disabled"}
                      onChange={() => setApiProxyModeType("disabled")}
                    />
                    <span>Desabilitado</span>
                  </label>
                  <label className="inline-flex items-center gap-1.5 text-[11px]">
                    <input
                      type="radio"
                      name="apiProxyMode"
                      className="h-3.5 w-3.5"
                      checked={apiProxyModeType === "url"}
                      onChange={() => setApiProxyModeType("url")}
                    />
                    <span>Proxy para URL</span>
                  </label>
                  <label className="inline-flex items-center gap-1.5 text-[11px]">
                    <input
                      type="radio"
                      name="apiProxyMode"
                      className="h-3.5 w-3.5"
                      checked={apiProxyModeType === "client"}
                      onChange={() => setApiProxyModeType("client")}
                    />
                    <span>Proxy para cliente (ngrok-style)</span>
                  </label>
                </div>
              </div>

              {apiProxyModeType === "url" && (
                <div className="rounded border border-blue-200 bg-blue-50 p-2 dark:border-blue-900 dark:bg-blue-950/30">
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] font-medium text-blue-700 dark:text-blue-300">
                      URL de destino
                    </span>
                    <input
                      type="url"
                      placeholder="https://api.exemplo.com"
                      className="h-7 rounded border border-zinc-300 bg-white px-2 font-mono text-[11px] text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                      value={apiProxyUrl}
                      onChange={(e) => setApiProxyUrl(e.target.value)}
                    />
                  </label>
                </div>
              )}

              {apiProxyModeType === "client" && (
                <div className="rounded border border-violet-200 bg-violet-50 p-2 dark:border-violet-900 dark:bg-violet-950/30">
                  <div className="mb-1 flex items-center gap-1">
                    <span className="text-[11px] font-medium text-violet-700 dark:text-violet-300">
                      Cliente conectado
                    </span>
                  </div>
                  {connectedClients.filter((c) => c.status === "online").length === 0 ? (
                    <div className="rounded bg-amber-100 px-2 py-1.5 text-[11px] text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
                      Nenhum cliente online.
                    </div>
                  ) : (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <label className="flex flex-col gap-1">
                        <span className="text-[10px] text-violet-600 dark:text-violet-400">
                          Cliente
                        </span>
                        <select
                          className="h-7 rounded border border-zinc-300 bg-white px-2 text-[11px] dark:border-zinc-700 dark:bg-zinc-950"
                          value={apiProxyClientId}
                          onChange={(e) => {
                            setApiProxyClientId(e.target.value);
                            setApiProxyServiceName("");
                          }}
                        >
                          <option value="">Selecione um cliente</option>
                          {connectedClients
                            .filter((c) => c.status === "online")
                            .map((client) => (
                              <option key={client.clientId} value={client.clientId}>
                                {client.clientName}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-[10px] text-violet-600 dark:text-violet-400">
                          Serviço
                        </span>
                        <select
                          className="h-7 rounded border border-zinc-300 bg-white px-2 text-[11px] dark:border-zinc-700 dark:bg-zinc-950"
                          value={apiProxyServiceName}
                          onChange={(e) => setApiProxyServiceName(e.target.value)}
                          disabled={!apiProxyClientId}
                        >
                          <option value="">Selecione um serviço</option>
                          {connectedClients
                            .find((c) => c.clientId === apiProxyClientId)
                            ?.localServices.map((service) => (
                              <option key={service.name} value={service.name}>
                                {service.name} ({service.host}:{service.port})
                              </option>
                            ))}
                        </select>
                      </label>
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-center justify-between gap-2">
                <button
                  type="submit"
                  disabled={apiConfigSaving}
                  className="inline-flex items-center rounded bg-zinc-900 px-3 py-1 text-[11px] font-medium text-zinc-50 hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                >
                  {apiConfigSaving ? "Salvando..." : "Salvar"}
                </button>
                {apiConfigMessage && (
                  <span className="text-[11px] text-zinc-500">{apiConfigMessage}</span>
                )}
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
