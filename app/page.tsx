"use client";

import React, { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

type ApiRequestLog = {
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

type ApiRouteStat = {
  id: string;
  method: string;
  path: string;
  count: number;
  firstTimestamp: string;
  lastTimestamp: string;
};

type ApiRouteConfig = {
  method: string;
  path: string;
  status: number;
  body: unknown;
  headers: Record<string, string>;
};

function normalizePathFront(path: string): string {
  if (!path) return "/";
  let result = path.trim();
  if (!result.startsWith("/")) result = `/${result}`;
  if (result.length > 1 && result.endsWith("/")) {
    result = result.slice(0, -1);
  }
  return result;
}

export default function Home() {
  const [logs, setLogs] = useState<ApiRequestLog[]>([]);
  const [routes, setRoutes] = useState<ApiRouteStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<number[]>([]);
  const [activeTab, setActiveTab] = useState<"requests" | "routes">("requests");
  const [configRouteId, setConfigRouteId] = useState<string | null>(null);
  const [configStatus, setConfigStatus] = useState<string>("200");
  const [configBody, setConfigBody] = useState<string>("{}");
  const [configHeaders, setConfigHeaders] = useState<string>("{}");
  const [configMessage, setConfigMessage] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  function toggleLogExpanded(id: number) {
    setExpandedIds((prev) =>
      prev.includes(id) ? prev.filter((logId) => logId !== id) : [...prev, id],
    );
  }

  async function openRouteConfig(route: ApiRouteStat) {
    const isSame = configRouteId === route.id;
    if (isSame) {
      setConfigRouteId(null);
      setConfigMessage(null);
      return;
    }

    // valores padrão
    setConfigRouteId(route.id);
    setConfigMessage(null);
    setConfigStatus("200");
    setConfigBody("{}");
    setConfigHeaders("{}");

    try {
      const res = await fetch("/api/routes/configs");
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
            : "{}",
        );
        setConfigHeaders(
          match.headers && Object.keys(match.headers).length
            ? JSON.stringify(match.headers, null, 2)
            : "{}",
        );
      }
    } catch (err) {
      console.error("Erro ao carregar config da rota:", err);
      // mantém os valores padrão, mas não quebra a UI
    }
  }

  useEffect(() => {
    let cancelled = false;

    // primeiro snapshot via HTTP, para fallback rápido
    async function initialLoad() {
      try {
        const [logsRes, routesRes] = await Promise.all([
          fetch("/api/logs"),
          fetch("/api/routes"),
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
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    }

    initialLoad();

    const es = new EventSource("/api/events");
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as {
          logs: ApiRequestLog[];
          routes: ApiRouteStat[];
        };
        if (!cancelled) {
          setLogs(data.logs);
          setRoutes(data.routes);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    };
    es.onerror = () => {
      if (!cancelled) {
        setError("Conexão com /api/events perdida. Tentando reconectar...");
      }
    };

    return () => {
      cancelled = true;
      es.close();
    };
  }, []);

  return (
    <div className="min-h-screen bg-zinc-50 font-sans text-zinc-900 dark:bg-black dark:text-zinc-50">
      <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-4 py-8">
        <header className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Freeceptor
            </h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Toda chamada a <code>/api/*</code> aparece aqui em tempo real.
            </p>
          </div>
          <div className="flex items-center gap-3">
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
                          const res = await fetch("/api/routes/configs");
                          if (!res.ok) throw new Error(await res.text());
                          const configs = (await res.json()) as ApiRouteConfig[];
                          const blob = new Blob(
                            [JSON.stringify(configs, null, 2)],
                            {
                              type: "application/json",
                            },
                          );
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement("a");
                          a.href = url;
                          const timestamp = new Date()
                            .toISOString()
                            .replace(/[:.]/g, "-");
                          a.download = `freeceptor-route-configs-${timestamp}.json`;
                          document.body.appendChild(a);
                          a.click();
                          document.body.removeChild(a);
                          URL.revokeObjectURL(url);
                        } catch (err) {
                          console.error("Erro ao exportar configs:", err);
                          setError(
                            err instanceof Error
                              ? `Erro ao exportar configs: ${err.message}`
                              : "Erro ao exportar configs",
                          );
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
                        await fetch("/api/logs", { method: "DELETE" });
                        setLogs([]);
                        setExpandedIds([]);
                      } catch (err) {
                        console.error("Erro ao limpar requisições:", err);
                      }
                    }}
                  >
                    🗑
                  </button>
                  <span className="pointer-events-none absolute -bottom-7 left-1/2 -translate-x-1/2 rounded bg-zinc-900 px-2 py-0.5 text-[10px] text-zinc-50 opacity-0 shadow-sm transition-opacity duration-100 group-hover:opacity-100 dark:bg-zinc-100 dark:text-zinc-900">
                    Limpar requisições
                  </span>
                </div>
              )}
            </div>
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
                Responses
              </button>
            </div>
          </div>
        </header>

        {error && (
          <div className="rounded-md bg-red-100 px-3 py-2 text-sm text-red-800 dark:bg-red-900/40 dark:text-red-200">
            Erro ao carregar logs: {error}
          </div>
        )}

        <section className="flex-1 overflow-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
            {activeTab === "requests" ? (
              <span>
                {loading
                  ? "Carregando requisições..."
                  : `${logs.length} requisições registradas (mostrando as mais recentes primeiro)`}
              </span>
            ) : (
              <span>
                {loading
                  ? "Carregando rotas..."
                  : `${routes.length} combinações método + path chamadas`}
              </span>
            )}
            <span className="font-mono text-[11px] text-zinc-500">
              atualiza em tempo real (SSE)
            </span>
          </div>

          <div className="max-h-[70vh] overflow-auto text-xs">
            {activeTab === "requests" ? (
              <table className="min-w-full border-separate border-spacing-0">
                <thead className="sticky top-0 bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                  <tr>
                    <th className="border-b border-zinc-200 px-3 py-2 text-left dark:border-zinc-800">
                      #
                    </th>
                    <th className="border-b border-zinc-200 px-3 py-2 text-left dark:border-zinc-800">
                      Horário
                    </th>
                    <th className="border-b border-zinc-200 px-3 py-2 text-left dark:border-zinc-800">
                      Método
                    </th>
                    <th className="border-b border-zinc-200 px-3 py-2 text-left dark:border-zinc-800">
                      Path
                    </th>
                    <th className="border-b border-zinc-200 px-3 py-2 text-right dark:border-zinc-800">
                      {/* coluna do botão de expandir */}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <React.Fragment key={log.id}>
                      <tr
                        className="cursor-pointer border-b border-zinc-100 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900/60"
                        onClick={() => toggleLogExpanded(log.id)}
                      >
                        <td className="px-3 py-2 align-top text-[11px] text-zinc-500">
                          {log.id}
                        </td>
                        <td className="px-3 py-2 align-top font-mono text-[11px]">
                          {new Date(log.timestamp).toLocaleTimeString()}
                        </td>
                        <td className="px-3 py-2 align-top">
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
                        </td>
                        <td className="px-3 py-2 align-top font-mono text-[11px]">
                          {log.slug.join(" / ") || "-"}
                        </td>
                        <td className="px-3 py-2 align-top text-right">
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded border border-zinc-300 px-1.5 py-0.5 text-[10px] font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleLogExpanded(log.id);
                            }}
                          >
                            <span
                              className="inline-block transition-transform"
                              style={{
                                transform: expandedIds.includes(log.id)
                                  ? "rotate(90deg)"
                                  : "rotate(0deg)",
                              }}
                            >
                              ▶
                            </span>
                            {expandedIds.includes(log.id)
                              ? "Recolher"
                              : "Expandir"}
                          </button>
                        </td>
                      </tr>
                      {expandedIds.includes(log.id) && (
                        <tr>
                          <td
                            colSpan={5}
                            className="border-b border-zinc-100 bg-zinc-50 px-3 py-3 text-[11px] text-zinc-700 dark:border-zinc-900 dark:bg-zinc-900 dark:text-zinc-200"
                          >
                            <div className="grid gap-3 md:grid-cols-2">
                              <div>
                                <div className="mb-1 text-[11px] font-medium text-zinc-500">
                                  Body (request)
                                </div>
                                <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded border border-zinc-200 bg-white px-2 py-1 font-mono text-[11px] text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100">
                                  {log.body != null && log.body !== ""
                                    ? JSON.stringify(log.body, null, 2)
                                    : "(sem body)"}
                                </pre>
                              </div>
                              <div>
                                <div className="mb-1 text-[11px] font-medium text-zinc-500">
                                  Headers (request)
                                </div>
                                <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded border border-zinc-200 bg-white px-2 py-1 font-mono text-[11px] text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100">
                                  {Object.keys(log.headers || {}).length
                                    ? JSON.stringify(log.headers, null, 2)
                                    : "(sem headers)"}
                                </pre>
                              </div>
                            </div>
                            <div className="mt-3 border-t border-dashed border-zinc-200 pt-3 text-[11px] dark:border-zinc-700">
                              <div className="mb-1 font-medium text-zinc-500">
                                Resposta enviada
                              </div>
                              <div className="mb-1 flex flex-wrap items-center gap-2">
                                <span className="inline-flex items-center rounded-full bg-zinc-900 px-2 py-0.5 font-mono text-[11px] text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900">
                                  status {log.responseStatus}
                                </span>
                              </div>
                              <div className="grid gap-3 md:grid-cols-2">
                                <div>
                                  <div className="mb-1 text-[11px] text-zinc-500">
                                    Body (response)
                                  </div>
                                  <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded border border-zinc-200 bg-white px-2 py-1 font-mono text-[11px] text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100">
                                    {log.responseBody != null &&
                                    log.responseBody !== ""
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
                                      ? JSON.stringify(
                                          log.responseHeaders,
                                          null,
                                          2,
                                        )
                                      : "(sem headers)"}
                                  </pre>
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                  {!loading && logs.length === 0 && (
                    <tr>
                      <td
                        colSpan={5}
                        className="px-3 py-6 text-center text-xs text-zinc-500"
                      >
                        Nenhuma requisição registrada ainda. Faça um
                        <code className="mx-1 rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px] dark:bg-zinc-900">
                          POST /api/qualquer/coisa
                        </code>
                        e veja aparecer aqui.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            ) : (
              <table className="min-w-full border-separate border-spacing-0">
                <thead className="sticky top-0 bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                  <tr>
                    <th className="border-b border-zinc-200 px-3 py-2 text-left dark:border-zinc-800">
                      Método
                    </th>
                    <th className="border-b border-zinc-200 px-3 py-2 text-left dark:border-zinc-800">
                      Path
                    </th>
                    <th className="border-b border-zinc-200 px-3 py-2 text-left dark:border-zinc-800">
                      Chamadas
                    </th>
                    <th className="border-b border-zinc-200 px-3 py-2 text-left dark:border-zinc-800">
                      Última chamada
                    </th>
                    <th className="border-b border-zinc-200 px-3 py-2 text-right dark:border-zinc-800">
                      Configurar resposta
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {routes.map((route) => (
                    <React.Fragment key={route.id}>
                      <tr
                        className="border-b border-zinc-100 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900/60"
                      >
                        <td className="px-3 py-2 align-top">
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
                        </td>
                        <td className="px-3 py-2 align-top font-mono text-[11px]">
                          {route.path
                            .replace(/^\/api/, "")
                            .split("/")
                            .filter(Boolean)
                            .join(" / ") || "-"}
                        </td>
                        <td className="px-3 py-2 align-top text-xs">
                          {route.count}
                        </td>
                        <td className="px-3 py-2 align-top font-mono text-[11px]">
                          {new Date(route.lastTimestamp).toLocaleTimeString()}
                        </td>
                        <td className="px-3 py-2 align-top text-right">
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded border border-zinc-300 px-2 py-1 text-[10px] font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800"
                            onClick={() => {
                              void openRouteConfig(route);
                            }}
                          >
                            Configurar
                          </button>
                        </td>
                      </tr>
                      {configRouteId === route.id && (
                        <tr>
                          <td
                            colSpan={5}
                            className="border-b border-zinc-100 bg-zinc-50 px-3 py-3 text-[11px] text-zinc-700 dark:border-zinc-900 dark:bg-zinc-900 dark:text-zinc-200"
                          >
                            <form
                              className="flex flex-col gap-2"
                              onSubmit={async (e) => {
                                e.preventDefault();
                                setConfigMessage(null);
                                try {
                                  const statusNumber = Number(configStatus) || 200;
                                  const parsedBody = configBody
                                    ? JSON.parse(configBody)
                                    : null;
                                  const parsedHeaders = configHeaders
                                    ? JSON.parse(configHeaders)
                                    : {};

                                  const res = await fetch("/api/routes", {
                                    method: "POST",
                                    headers: {
                                      "Content-Type": "application/json",
                                    },
                                    body: JSON.stringify({
                                      method: route.method,
                                      path: route.path,
                                      status: statusNumber,
                                      headers: parsedHeaders,
                                      responseBody: parsedBody,
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
                              <div className="flex flex-wrap gap-2">
                                <label className="flex items-center gap-1 text-[11px]">
                                  <span className="text-zinc-500">Status</span>
                                  <input
                                    type="number"
                                    min={100}
                                    max={599}
                                    className="h-6 w-16 rounded border border-zinc-300 bg-white px-1 font-mono text-[11px] text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                                    value={configStatus}
                                    onChange={(e) => setConfigStatus(e.target.value)}
                                  />
                                </label>
                              </div>
                              <div className="grid gap-2 md:grid-cols-2">
                                <label className="flex flex-col gap-1">
                                  <span className="text-[11px] text-zinc-500">
                                    Body (JSON)
                                  </span>
                                  <textarea
                                    rows={4}
                                    className="w-full rounded border border-zinc-300 bg-white px-2 py-1 font-mono text-[11px] text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                                    value={configBody}
                                    onChange={(e) => setConfigBody(e.target.value)}
                                  />
                                </label>
                                <label className="flex flex-col gap-1">
                                  <span className="text-[11px] text-zinc-500">
                                    Cabeçalhos (JSON)
                                  </span>
                                  <textarea
                                    rows={4}
                                    className="w-full rounded border border-zinc-300 bg-white px-2 py-1 font-mono text-[11px] text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                                    value={configHeaders}
                                    onChange={(e) => setConfigHeaders(e.target.value)}
                                  />
                                </label>
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
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                  {!loading && routes.length === 0 && (
                    <tr>
                      <td
                        colSpan={4}
                        className="px-3 py-6 text-center text-xs text-zinc-500"
                      >
                        Nenhuma rota registrada ainda. Faça uma chamada para
                        <code className="mx-1 rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px] dark:bg-zinc-900">
                          /api/alguma/coisa
                        </code>
                        e veja aparecer aqui.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </main>
      {importOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-xl rounded-lg bg-white p-4 shadow-lg dark:bg-zinc-950">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                  Importar configurações de rotas
                </h2>
                <p className="text-xs text-zinc-600 dark:text-zinc-400">
                  Cole o JSON exportado ou arraste um arquivo
                  <code className="mx-1 rounded bg-zinc-100 px-1 py-[1px] font-mono text-[10px] dark:bg-zinc-900">
                    .json
                  </code>
                  .
                </p>
              </div>
              <button
                type="button"
                className="rounded-full p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-900"
                onClick={() => {
                  if (!importing) {
                    setImportOpen(false);
                  }
                }}
              >
                ✕
              </button>
            </div>

            <div
              className="mb-3 flex h-64 cursor-pointer flex-col overflow-auto rounded-md border border-dashed border-zinc-300 bg-zinc-50 px-3 py-2 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              onDragOver={(e) => {
                e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (e.dataTransfer.files?.[0]) {
                  const file = e.dataTransfer.files[0];
                  const reader = new FileReader();
                  reader.onload = () => {
                    const raw = typeof reader.result === "string" ? reader.result : "";
                    // tenta formatar o JSON para ficar mais legível no textarea
                    try {
                      const parsed = JSON.parse(raw);
                      setImportText(JSON.stringify(parsed, null, 2));
                    } catch {
                      setImportText(raw);
                    }
                  };
                  reader.readAsText(file);
                }
              }}
            >
              <textarea
                className="h-full w-full resize-none border-none bg-transparent font-mono text-[11px] outline-none"
                placeholder='Cole aqui um array de configs, ex.: [{"method":"POST","path":"/api/...","status":200,"body":{...},"headers":{...}}]'
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
              />
            </div>

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
                    if (!importing) {
                      setImportOpen(false);
                    }
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
                        throw new Error("Cole o JSON ou arraste um arquivo primeiro.");
                      }
                      const parsed = JSON.parse(importText) as
                        | ApiRouteConfig[]
                        | ApiRouteConfig;
                      const configs = Array.isArray(parsed) ? parsed : [parsed];
                      for (const cfg of configs) {
                        const res = await fetch("/api/routes", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            method: cfg.method,
                            path: cfg.path,
                            status: cfg.status,
                            headers: cfg.headers ?? {},
                            responseBody: cfg.body ?? null,
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
    </div>
  );
}

