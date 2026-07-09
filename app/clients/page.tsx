"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

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

type RequestResponse = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  error?: string;
};

type SendRequestResult = {
  requestId: string;
  status: "pending" | "completed" | "timeout";
  response?: RequestResponse;
  error?: string;
};

function formatTimestamp(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleString();
}

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  
  if (diffSec < 60) return `${diffSec}s atrás`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m atrás`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h atrás`;
  return `${Math.floor(diffSec / 86400)}d atrás`;
}

export default function ClientsPage() {
  const pathname = usePathname();
  const backHref = pathname.replace(/\/clients$/, "") || "/";

  const [clients, setClients] = useState<ProxyClientInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedClient, setSelectedClient] = useState<ProxyClientInfo | null>(null);
  const [selectedService, setSelectedService] = useState<string>("");
  const [requestMethod, setRequestMethod] = useState<string>("GET");
  const [requestPath, setRequestPath] = useState<string>("/");
  const [requestBody, setRequestBody] = useState<string>("");
  const [requestHeaders, setRequestHeaders] = useState<string>("{}");
  const [sending, setSending] = useState(false);
  const [requestResult, setRequestResult] = useState<SendRequestResult | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let attempt = 0;

    function connect() {
      if (cancelled) return;
      es = new EventSource("/api/events/clients");

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as { clients?: ProxyClientInfo[] };
          if (!cancelled && data.clients) {
            setClients(data.clients);
            setError(null);
            setLoading(false);
            attempt = 0;
          }
        } catch {
          // ignorar mensagens mal formadas
        }
      };

      es.onerror = (e) => {
        if (cancelled) return;
        es?.close();
        es = null;

        const status = (e as unknown as { status?: number }).status;
        if (status === 401) {
          setError("Você precisa estar autenticado. Faça login na página principal.");
          setLoading(false);
          return;
        }

        const delay = Math.min(1000 * 2 ** attempt, 10000);
        attempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      cancelled = true;
      es?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, []);

  useEffect(() => {
    if (selectedClient && selectedClient.localServices.length > 0 && !selectedService) {
      setSelectedService(selectedClient.localServices[0].name);
    }
  }, [selectedClient, selectedService]);

  async function sendRequest() {
    if (!selectedClient || !selectedService) return;

    setSending(true);
    setRequestResult(null);

    try {
      let parsedHeaders: Record<string, string> = {};
      try {
        parsedHeaders = JSON.parse(requestHeaders);
      } catch {
        parsedHeaders = {};
      }

      let parsedBody: unknown = null;
      if (requestBody.trim()) {
        try {
          parsedBody = JSON.parse(requestBody);
        } catch {
          parsedBody = requestBody;
        }
      }

      const res = await fetch("/api/proxy/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetClientId: selectedClient.clientId,
          serviceName: selectedService,
          method: requestMethod,
          path: requestPath,
          headers: parsedHeaders,
          body: parsedBody,
          waitForResponse: true,
          timeoutMs: 30000,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setRequestResult({
          requestId: "",
          status: "timeout",
          error: data.error || "Erro ao enviar requisição",
        });
        return;
      }

      setRequestResult(data);
    } catch (err) {
      setRequestResult({
        requestId: "",
        status: "timeout",
        error: err instanceof Error ? err.message : "Erro desconhecido",
      });
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-50 font-sans text-zinc-900 dark:bg-black dark:text-zinc-50">
        <main className="mx-auto flex min-h-screen max-w-5xl items-center justify-center px-4">
          <div className="text-sm text-zinc-600 dark:text-zinc-300">
            Carregando clientes...
          </div>
        </main>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-zinc-50 font-sans text-zinc-900 dark:bg-black dark:text-zinc-50">
        <main className="mx-auto flex min-h-screen max-w-5xl flex-col items-center justify-center px-4">
          <div className="rounded-md bg-red-100 px-4 py-3 text-sm text-red-800 dark:bg-red-900/40 dark:text-red-200">
            {error}
          </div>
          <Link
            href="/"
            className="mt-4 text-sm text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            Ir para a página principal
          </Link>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 font-sans text-zinc-900 dark:bg-black dark:text-zinc-50">
      <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-8">
        <header className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Clientes Conectados
            </h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Gerencie e envie requisições para clientes proxy conectados.
            </p>
          </div>
          <Link
            href={backHref}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            ← Voltar
          </Link>
        </header>

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
            <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <h2 className="text-sm font-medium">
                Clientes ({clients.length})
              </h2>
            </div>
            <div className="max-h-[60vh] overflow-auto p-3">
              {clients.length === 0 ? (
                <div className="rounded border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
                  <p className="mb-2">Nenhum cliente conectado.</p>
                  <p className="text-xs text-zinc-400">
                    Configure e inicie o proxy-reverse em uma máquina para vê-la aqui.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {clients.map((client) => (
                    <div
                      key={client.clientId}
                      onClick={() => {
                        setSelectedClient(client);
                        setSelectedService(client.localServices[0]?.name || "");
                        setRequestResult(null);
                      }}
                      className={cn(
                        "cursor-pointer rounded-md border p-3 transition-colors",
                        selectedClient?.clientId === client.clientId
                          ? "border-zinc-900 bg-zinc-100 dark:border-zinc-100 dark:bg-zinc-900"
                          : "border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:border-zinc-700 dark:hover:bg-zinc-900/50"
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              "h-2 w-2 rounded-full",
                              client.status === "online"
                                ? "bg-emerald-500"
                                : "bg-zinc-400"
                            )}
                          />
                          <span className="font-medium text-sm">
                            {client.clientName}
                          </span>
                        </div>
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase",
                            client.status === "online"
                              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                              : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                          )}
                        >
                          {client.status}
                        </span>
                      </div>
                      <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                        <span className="font-mono">{client.clientId}</span>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {client.localServices.map((service) => (
                          <span
                            key={service.name}
                            className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                          >
                            {service.name}:{service.port}
                          </span>
                        ))}
                      </div>
                      <div className="mt-2 flex items-center justify-between text-[10px] text-zinc-400">
                        <span>Conectado: {formatTimestamp(client.connectedAt)}</span>
                        <span>Heartbeat: {formatRelativeTime(client.lastHeartbeat)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
            <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <h2 className="text-sm font-medium">
                Enviar Requisição
              </h2>
            </div>
            <div className="p-4">
              {!selectedClient ? (
                <div className="rounded border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
                  Selecione um cliente para enviar requisições.
                </div>
              ) : selectedClient.status !== "online" ? (
                <div className="rounded border border-dashed border-amber-300 bg-amber-50 px-4 py-8 text-center text-sm text-amber-700 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
                  Este cliente está offline. Aguarde ele reconectar.
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-500">Cliente:</span>
                    <span className="font-medium text-sm">{selectedClient.clientName}</span>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-zinc-500">Serviço</span>
                      <select
                        value={selectedService}
                        onChange={(e) => setSelectedService(e.target.value)}
                        className="h-8 rounded border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                      >
                        {selectedClient.localServices.map((service) => (
                          <option key={service.name} value={service.name}>
                            {service.name} ({service.host}:{service.port})
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-zinc-500">Método</span>
                      <select
                        value={requestMethod}
                        onChange={(e) => setRequestMethod(e.target.value)}
                        className="h-8 rounded border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                      >
                        <option value="GET">GET</option>
                        <option value="POST">POST</option>
                        <option value="PUT">PUT</option>
                        <option value="PATCH">PATCH</option>
                        <option value="DELETE">DELETE</option>
                      </select>
                    </label>
                  </div>

                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-zinc-500">Path</span>
                    <input
                      type="text"
                      value={requestPath}
                      onChange={(e) => setRequestPath(e.target.value)}
                      className="h-8 rounded border border-zinc-300 bg-white px-2 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
                      placeholder="/api/endpoint"
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-zinc-500">Headers (JSON)</span>
                    <textarea
                      value={requestHeaders}
                      onChange={(e) => setRequestHeaders(e.target.value)}
                      rows={2}
                      className="rounded border border-zinc-300 bg-white px-2 py-1 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
                      placeholder='{"Content-Type": "application/json"}'
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-zinc-500">Body (JSON)</span>
                    <textarea
                      value={requestBody}
                      onChange={(e) => setRequestBody(e.target.value)}
                      rows={3}
                      className="rounded border border-zinc-300 bg-white px-2 py-1 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
                      placeholder='{"key": "value"}'
                    />
                  </label>

                  <button
                    type="button"
                    onClick={sendRequest}
                    disabled={sending || !selectedService}
                    className="inline-flex h-9 items-center justify-center rounded bg-zinc-900 px-4 text-sm font-medium text-zinc-50 hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                  >
                    {sending ? "Enviando..." : "Enviar Requisição"}
                  </button>

                  {requestResult && (
                    <div className="mt-4 rounded-md border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-xs font-medium text-zinc-500">Resposta</span>
                        {requestResult.status === "completed" && requestResult.response && (
                          <span
                            className={cn(
                              "rounded-full px-2 py-0.5 font-mono text-xs font-semibold",
                              requestResult.response.status >= 200 && requestResult.response.status < 300
                                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                                : requestResult.response.status >= 400
                                  ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
                                  : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                            )}
                          >
                            {requestResult.response.status}
                          </span>
                        )}
                        {requestResult.status === "timeout" && (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                            Timeout
                          </span>
                        )}
                      </div>

                      {requestResult.error && (
                        <div className="mb-2 rounded bg-red-100 px-2 py-1 text-xs text-red-700 dark:bg-red-900/40 dark:text-red-300">
                          {requestResult.error}
                        </div>
                      )}

                      {requestResult.response?.body !== undefined && (
                        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded border border-zinc-200 bg-white px-2 py-1 font-mono text-[11px] text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100">
                          {typeof requestResult.response.body === "string"
                            ? requestResult.response.body
                            : JSON.stringify(requestResult.response.body, null, 2)}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
