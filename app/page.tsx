"use client";

import { useEffect, useState } from "react";

type ApiRequestLog = {
  id: number;
  timestamp: string;
  method: string;
  path: string;
  slug: string[];
  body: unknown;
  headers: Record<string, string>;
};

type ApiRouteStat = {
  id: string;
  method: string;
  path: string;
  count: number;
  firstTimestamp: string;
  lastTimestamp: string;
};

export default function Home() {
  const [logs, setLogs] = useState<ApiRequestLog[]>([]);
  const [routes, setRoutes] = useState<ApiRouteStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<number[]>([]);
  const [activeTab, setActiveTab] = useState<"requests" | "routes">("requests");

  useEffect(() => {
    let cancelled = false;

    async function load() {
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
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();
    const interval = setInterval(load, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <div className="min-h-screen bg-zinc-50 font-sans text-zinc-900 dark:bg-black dark:text-zinc-50">
      <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-4 py-8">
        <header className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Monitor de requisições da API
            </h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Toda chamada a <code>/api/*</code> aparece aqui em tempo quase
              real.
            </p>
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
              Rotas
            </button>
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
              atualiza a cada 2s
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
                    <th className="border-b border-zinc-200 px-3 py-2 text-left dark:border-zinc-800">
                      Body
                    </th>
                    <th className="border-b border-zinc-200 px-3 py-2 text-left dark:border-zinc-800">
                      {/* coluna da setinha */}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr
                      key={log.id}
                      className="border-b border-zinc-100 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900/60"
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
                      <td className="max-w-xs px-3 py-2 align-top font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
                        <pre className="whitespace-pre-wrap break-words">
                          {log.body != null && log.body !== ""
                            ? expandedIds.includes(log.id)
                              ? JSON.stringify(log.body, null, 2)
                              : (() => {
                                  const full = JSON.stringify(log.body);
                                  return full.length > 160
                                    ? `${full.slice(0, 160)}…`
                                    : full;
                                })()
                            : "(sem body)"}
                        </pre>
                      </td>
                      <td className="px-3 py-2 align-top text-right">
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded border border-zinc-300 px-1.5 py-0.5 text-[10px] font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800"
                          onClick={() =>
                            setExpandedIds((prev) =>
                              prev.includes(log.id)
                                ? prev.filter((id) => id !== log.id)
                                : [...prev, log.id],
                            )
                          }
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
                  ))}
                  {!loading && logs.length === 0 && (
                    <tr>
                      <td
                        colSpan={6}
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
                  </tr>
                </thead>
                <tbody>
                  {routes.map((route) => (
                    <tr
                      key={route.id}
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
                        {route.path.replace(/^\/api/, "").split("/").filter(Boolean).join(" / ") ||
                          "-"}
                      </td>
                      <td className="px-3 py-2 align-top text-xs">
                        {route.count}
                      </td>
                      <td className="px-3 py-2 align-top font-mono text-[11px]">
                        {new Date(route.lastTimestamp).toLocaleTimeString()}
                      </td>
                    </tr>
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
    </div>
  );
}

