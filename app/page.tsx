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

export default function Home() {
  const [logs, setLogs] = useState<ApiRequestLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<number[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/logs");
        if (!res.ok) throw new Error(await res.text());
        const data = (await res.json()) as ApiRequestLog[];
        if (!cancelled) {
          setLogs(data);
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
        </header>

        {error && (
          <div className="rounded-md bg-red-100 px-3 py-2 text-sm text-red-800 dark:bg-red-900/40 dark:text-red-200">
            Erro ao carregar logs: {error}
          </div>
        )}

        <section className="flex-1 overflow-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
            <span>
              {loading
                ? "Carregando requisições..."
                : `${logs.length} requisições registradas (mostrando as mais recentes primeiro)`}
            </span>
            <span className="font-mono text-[11px] text-zinc-500">
              atualiza a cada 2s
            </span>
          </div>

          <div className="max-h-[70vh] overflow-auto text-xs">
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
                        {expandedIds.includes(log.id) ? "Recolher" : "Expandir"}
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
          </div>
        </section>
      </main>
    </div>
  );
}

