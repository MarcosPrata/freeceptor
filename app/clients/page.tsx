"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const FREECEPTOR_CLIENT_IMAGE = "mhpjunior/freeceptor-client:latest";

function getServerNameFromPath(pathname: string): string {
  const match = pathname.match(/\/server\/([^/]+)(?:\/|$)/);
  if (!match?.[1]) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

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
  requiresEditPassword?: boolean;
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

type EditableService = {
  id: string;
  name: string;
  port: string;
};

function createEditableServiceId(): string {
  return `svc-${Math.random().toString(36).slice(2, 10)}`;
}

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

function servicesToEditable(services: ProxyServiceInfo[]): EditableService[] {
  return services.map((service) => ({
    id: createEditableServiceId(),
    name: service.name,
    port: String(service.port),
  }));
}

function emptyService(): EditableService {
  return { id: createEditableServiceId(), name: "", port: "" };
}

function servicesSignature(services: ProxyServiceInfo[]): string {
  return JSON.stringify(
    services.map((service) => ({
      name: service.name.trim(),
      port: String(service.port),
    })),
  );
}

function editableServicesSignature(services: EditableService[]): string {
  return JSON.stringify(
    services.map((service) => ({
      name: service.name.trim(),
      port: service.port.trim(),
    })),
  );
}

export default function ClientsPage() {
  const pathname = usePathname();
  const backHref = pathname.replace(/\/clients$/, "") || "/";
  const serverNameFromPath = useMemo(
    () => getServerNameFromPath(pathname),
    [pathname],
  );

  const [clients, setClients] = useState<ProxyClientInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [rightPanelView, setRightPanelView] = useState<"edit" | "request">("edit");
  const [actionsOpen, setActionsOpen] = useState(false);
  const [dockerRunCopied, setDockerRunCopied] = useState(false);
  const actionsMenuRef = useRef<HTMLDivElement>(null);

  const [editClientName, setEditClientName] = useState("");
  const [editServices, setEditServices] = useState<EditableService[]>([]);
  const [editPassword, setEditPassword] = useState("");
  const [savePasswordOpen, setSavePasswordOpen] = useState(false);
  const [savedEditSnapshot, setSavedEditSnapshot] = useState<{
    clientName: string;
    services: EditableService[];
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const [selectedService, setSelectedService] = useState<string>("");
  const [requestMethod, setRequestMethod] = useState<string>("GET");
  const [requestPath, setRequestPath] = useState<string>("/");
  const [requestBody, setRequestBody] = useState<string>("");
  const [requestHeaders, setRequestHeaders] = useState<string>("{}");
  const [sending, setSending] = useState(false);
  const [requestResult, setRequestResult] = useState<SendRequestResult | null>(null);

  const selectedClient =
    clients.find((client) => client.clientId === selectedClientId) ?? null;
  const selectedClientRequiresEditPassword = Boolean(
    selectedClient?.requiresEditPassword,
  );
  const hasUnsavedChanges = useMemo(() => {
    if (!selectedClient) return false;

    const nameChanged =
      editClientName.trim() !== selectedClient.clientName.trim();
    const servicesChanged =
      editableServicesSignature(editServices) !==
      servicesSignature(selectedClient.localServices);

    return nameChanged || servicesChanged;
  }, [selectedClient, editClientName, editServices]);

  // Último snapshot do server aplicado no formulário (para sincronizar SSE sem apagar edição local).
  const appliedLiveSigRef = useRef<string>("");

  useEffect(() => {
    if (!selectedClient) {
      appliedLiveSigRef.current = "";
      return;
    }

    const liveSig = `${selectedClient.clientId}|${selectedClient.clientName}|${servicesSignature(selectedClient.localServices)}`;
    if (liveSig === appliedLiveSigRef.current) return;

    const clientChanged =
      !appliedLiveSigRef.current ||
      !appliedLiveSigRef.current.startsWith(`${selectedClient.clientId}|`);

    const formSig = `${selectedClient.clientId}|${editClientName.trim()}|${editableServicesSignature(editServices)}`;
    const formMatchesApplied = formSig === appliedLiveSigRef.current;

    // Com senha / troca de cliente / sem edição local: espelha o client ao vivo.
    if (
      selectedClientRequiresEditPassword ||
      clientChanged ||
      formMatchesApplied
    ) {
      setEditClientName(selectedClient.clientName);
      setEditServices(servicesToEditable(selectedClient.localServices));
      setSelectedService((prev) => {
        const names = selectedClient.localServices.map((service) => service.name);
        return prev && names.includes(prev) ? prev : names[0] || "";
      });
      appliedLiveSigRef.current = liveSig;
    }
  }, [
    selectedClient,
    selectedClientRequiresEditPassword,
    editClientName,
    editServices,
  ]);

  useEffect(() => {
    if (!actionsOpen) return;

    function handlePointerDown(event: MouseEvent) {
      if (
        actionsMenuRef.current &&
        !actionsMenuRef.current.contains(event.target as Node)
      ) {
        setActionsOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setActionsOpen(false);
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [actionsOpen]);

  function buildDockerRunCommand(): string {
    const serverName =
      serverNameFromPath ||
      selectedClient?.serverName ||
      clients[0]?.serverName ||
      "";

    // Mesma porta no host e no container (UI_PORT).
    // FREECEPTOR_URL / host do gateway: o client infere sozinho no Docker.
    const uiPort = 8002;
    const parts = [
      "docker run --name freeceptor-client",
      `-p ${uiPort}:${uiPort}`,
      `-e UI_PORT=${uiPort}`,
      serverName ? `-e SERVER_NAME=${serverName}` : "",
      FREECEPTOR_CLIENT_IMAGE,
    ].filter(Boolean);

    return parts.join(" ");
  }

  function copyDockerRun() {
    void navigator.clipboard.writeText(buildDockerRunCommand()).then(() => {
      setDockerRunCopied(true);
      setActionsOpen(false);
      setTimeout(() => setDockerRunCopied(false), 2000);
    }).catch(() => {
      /* ignore */
    });
  }

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

  function selectClient(client: ProxyClientInfo) {
    setSelectedClientId(client.clientId);
    setEditClientName(client.clientName);
    setEditServices(servicesToEditable(client.localServices));
    appliedLiveSigRef.current = `${client.clientId}|${client.clientName}|${servicesSignature(client.localServices)}`;
    setRightPanelView("edit");
    setSaveError(null);
    setSaveSuccess(false);
    setEditPassword("");
    setSavePasswordOpen(false);
    setSavedEditSnapshot(null);
    setSelectedService(client.localServices[0]?.name || "");
    setRequestResult(null);
  }

  function resetEditFormFromSaved() {
    if (!selectedClient) return;

    setEditClientName(selectedClient.clientName);
    setEditServices(servicesToEditable(selectedClient.localServices));
    setSaveError(null);
    setSaveSuccess(false);
  }

  function revertClientEdits() {
    const snapshot = savedEditSnapshot;
    if (snapshot) {
      setEditClientName(snapshot.clientName);
      setEditServices(snapshot.services);
    } else {
      resetEditFormFromSaved();
    }

    setSavedEditSnapshot(null);
    setSavePasswordOpen(false);
    setEditPassword("");
    setSaveError(null);
    setSaveSuccess(false);
  }

  async function saveClientConfig(password?: string) {
    if (!selectedClient) return;

    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);

    try {
      const localServices = editServices
        .filter((service) => service.name.trim() && service.port.trim())
        .map((service) => {
          const name = service.name.trim();
          const existingHost = selectedClient.localServices.find(
            (s) => s.name.trim() === name,
          )?.host;
          return {
            name,
            // Host é definido pelo client (Docker vs local); o front só edita nome/porta.
            host: existingHost?.trim() || "localhost",
            port: Number(service.port),
          };
        });

      if (!editClientName.trim()) {
        throw new Error("O nome do cliente é obrigatório.");
      }
      if (localServices.some((service) => Number.isNaN(service.port) || service.port <= 0)) {
        throw new Error("Todas as portas precisam ser números válidos.");
      }

      const payload: {
        clientId: string;
        clientName: string;
        localServices: ProxyServiceInfo[];
        password?: string;
      } = {
        clientId: selectedClient.clientId,
        clientName: editClientName.trim(),
        localServices,
      };

      const resolvedPassword = password ?? editPassword;
      if (selectedClientRequiresEditPassword) {
        if (!resolvedPassword.trim()) {
          throw new Error("Informe a senha do cliente para salvar.");
        }
        payload.password = resolvedPassword;
      }

      const res = await fetch("/api/proxy/clients", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Erro ao salvar cliente");
      }

      if (data.client) {
        setClients((prev) =>
          prev.map((client) =>
            client.clientId === data.client.clientId ? data.client : client,
          ),
        );
        setEditClientName(data.client.clientName);
        setEditServices(servicesToEditable(data.client.localServices));
        setSelectedService(data.client.localServices[0]?.name || "");
      }

      setEditPassword("");
      setSavePasswordOpen(false);
      setSavedEditSnapshot(null);
      setSaveSuccess(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Erro ao salvar cliente");
    } finally {
      setSaving(false);
    }
  }

  function handleSaveClick() {
    if (!selectedClient) return;

    if (selectedClientRequiresEditPassword) {
      setSaveError(null);
      setEditPassword("");
      setSavedEditSnapshot({
        clientName: selectedClient.clientName,
        services: servicesToEditable(selectedClient.localServices),
      });
      setSavePasswordOpen(true);
      return;
    }
    void saveClientConfig();
  }

  function updateService(
    index: number,
    field: keyof EditableService,
    value: string,
  ) {
    setEditServices((prev) =>
      prev.map((service, i) =>
        i === index ? { ...service, [field]: value } : service,
      ),
    );
  }

  function removeService(index: number) {
    setEditServices((prev) => prev.filter((_, i) => i !== index));
  }

  function addService() {
    setEditServices((prev) => [...prev, emptyService()]);
  }

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
      <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-4 px-4 py-8">
        <header className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <img
              src="/logo.png"
              alt="Freeceptor"
              width={72}
              height={72}
              className="size-[72px] shrink-0 rounded-md"
            />
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold leading-tight tracking-tight">
                Clientes Conectados
              </h1>
              {serverNameFromPath && (
                <p className="mt-0.5 text-xs leading-snug text-zinc-500 dark:text-zinc-400">
                  Server: <code className="font-mono">{serverNameFromPath}</code>
                </p>
              )}
              <p className="mt-1 text-sm leading-snug text-zinc-600 dark:text-zinc-400">
                Gerencie e envie requisições para clientes proxy conectados.
              </p>
            </div>
          </div>
          <Link
            href={backHref}
            className="mt-1 flex shrink-0 items-center gap-1.5 rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            ← Voltar
          </Link>
        </header>

        <div className="grid gap-4 lg:grid-cols-[minmax(260px,2fr)_minmax(0,3fr)]">
          <section className="rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
              <h2 className="text-xs text-zinc-500 dark:text-zinc-400">
                Clientes ({clients.length})
              </h2>
              <div className="relative" ref={actionsMenuRef}>
                <button
                  type="button"
                  aria-label="Ações do cliente"
                  aria-expanded={actionsOpen}
                  aria-haspopup="menu"
                  title={dockerRunCopied ? "Comando copiado!" : "Ações"}
                  onClick={() => setActionsOpen((open) => !open)}
                  className={cn(
                    "inline-flex h-8 w-8 items-center justify-center rounded-full border border-zinc-300 bg-white text-zinc-500 shadow-sm transition-colors",
                    "hover:bg-zinc-100 hover:text-zinc-800",
                    "dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100",
                    actionsOpen && "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-100",
                    dockerRunCopied &&
                      "border-emerald-300 text-emerald-600 dark:border-emerald-700 dark:text-emerald-300",
                  )}
                >
                  {dockerRunCopied ? (
                    <svg
                      viewBox="0 0 24 24"
                      className="h-3.5 w-3.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  ) : (
                    <svg
                      viewBox="0 0 24 24"
                      className="h-4 w-4"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <circle cx="5" cy="12" r="1.6" />
                      <circle cx="12" cy="12" r="1.6" />
                      <circle cx="19" cy="12" r="1.6" />
                    </svg>
                  )}
                </button>
                {actionsOpen && (
                  <div
                    role="menu"
                    className="absolute right-0 z-20 mt-1 min-w-[220px] rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-950"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={copyDockerRun}
                      className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-900"
                    >
                      <span>Copiar docker run</span>
                      <svg
                        viewBox="0 0 24 24"
                        className="h-3.5 w-3.5 shrink-0 text-zinc-400"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <rect x="9" y="9" width="13" height="13" rx="2" />
                        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                      </svg>
                    </button>
                  </div>
                )}
              </div>
            </div>
            <div className="max-h-[60vh] overflow-auto p-3">
              {clients.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 rounded border border-dashed border-zinc-300 px-4 py-10 text-center dark:border-zinc-700">
                  <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    Nenhum cliente conectado.
                  </p>
                  <button
                    type="button"
                    title={dockerRunCopied ? "Copiado!" : "Clique para copiar"}
                    onClick={copyDockerRun}
                    className={cn(
                      "inline-flex max-w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs transition-colors",
                      dockerRunCopied
                        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                        : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700",
                    )}
                  >
                    {dockerRunCopied ? (
                      <svg
                        viewBox="0 0 24 24"
                        className="h-3 w-3 shrink-0"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    ) : (
                      <svg
                        viewBox="0 0 24 24"
                        className="h-3 w-3 shrink-0"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <rect x="9" y="9" width="13" height="13" rx="2" />
                        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                      </svg>
                    )}
                    <span>
                      {dockerRunCopied
                        ? "Comando copiado!"
                        : "Copie o docker run e rode o client na sua máquina"}
                    </span>
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  {clients.map((client) => (
                    <div
                      key={client.clientId}
                      onClick={() => selectClient(client)}
                      className={cn(
                        "cursor-pointer rounded-md border p-3 transition-colors",
                        selectedClientId === client.clientId
                          ? "border-zinc-900 bg-zinc-100 dark:border-zinc-100 dark:bg-zinc-900"
                          : "border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:border-zinc-700 dark:hover:bg-zinc-900/50",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              "h-2 w-2 rounded-full",
                              client.status === "online"
                                ? "bg-emerald-500"
                                : "bg-zinc-400",
                            )}
                          />
                          <span className="text-sm font-medium">
                            {client.clientName}
                          </span>
                        </div>
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase",
                            client.status === "online"
                              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                              : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
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
            <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
              <h2 className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                {rightPanelView === "edit" ? "Configuração do Cliente" : "Enviar Requisição"}
                {selectedClientRequiresEditPassword && rightPanelView === "edit" && (
                  <span
                    title="Configuração protegida — edite apenas no client"
                    aria-label="Cliente protegido por senha"
                    className="inline-flex text-zinc-400 dark:text-zinc-500"
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
                      <rect x="5" y="11" width="14" height="10" rx="2" />
                      <path d="M8 11V8a4 4 0 018 0v3" />
                    </svg>
                  </span>
                )}
              </h2>
              {selectedClient && rightPanelView === "request" && (
                <button
                  type="button"
                  onClick={() => setRightPanelView("edit")}
                  className="text-[11px] text-zinc-500 transition-colors hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"
                >
                  ← Voltar à configuração
                </button>
              )}
            </div>

            <div className="p-3">
              {!selectedClient ? (
                <div className="flex items-center justify-center gap-3 rounded border border-dashed border-zinc-300 px-3 py-10 text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-500">
                  <svg
                    className="shrink-0 text-zinc-400 dark:text-zinc-600"
                    xmlns="http://www.w3.org/2000/svg"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </svg>
                  Selecione um cliente para editar suas configurações.
                </div>
              ) : rightPanelView === "edit" ? (
                <div className="space-y-4">
                  {selectedClientRequiresEditPassword && (
                    <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                      Este cliente tem senha — a configuração só pode ser alterada no Freeceptor Client.
                    </div>
                  )}

                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="flex flex-col gap-1 sm:col-span-2">
                      <span className="text-xs text-zinc-500">Client ID</span>
                      <input
                        type="text"
                        value={selectedClient.clientId}
                        readOnly
                        className="h-9 rounded border border-zinc-200 bg-zinc-50 px-2 font-mono text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
                      />
                    </label>

                    <label className="flex flex-col gap-1 sm:col-span-2">
                      <span className="text-xs text-zinc-500">Nome do cliente</span>
                      <input
                        type="text"
                        value={editClientName}
                        onChange={(e) => setEditClientName(e.target.value)}
                        readOnly={selectedClientRequiresEditPassword}
                        disabled={selectedClientRequiresEditPassword}
                        className={cn(
                          "h-9 rounded border px-2 text-sm",
                          selectedClientRequiresEditPassword
                            ? "border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
                            : "border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900",
                        )}
                        placeholder="Ex: MacBook Pro"
                      />
                    </label>
                  </div>

                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-xs font-medium text-zinc-500">
                        Serviços disponíveis
                      </span>
                      {!selectedClientRequiresEditPassword && (
                        <button
                          type="button"
                          onClick={addService}
                          className="inline-flex items-center rounded-full border border-dashed border-zinc-300 px-2.5 py-1 text-[11px] font-medium text-zinc-400 transition-colors hover:border-zinc-400 hover:text-zinc-600 dark:border-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-300"
                        >
                          + Adicionar serviço
                        </button>
                      )}
                    </div>

                    <div className="space-y-2">
                      {editServices.length === 0 && (
                        <p className="rounded-md border border-dashed border-zinc-300 px-3 py-2 text-xs text-zinc-500 dark:border-zinc-700">
                          Nenhum serviço exposto.
                        </p>
                      )}
                      {editServices.map((service, index) => (
                        <div
                          key={service.id}
                          className={cn(
                            "grid gap-2 rounded-md border border-zinc-200 p-2 dark:border-zinc-800",
                            selectedClientRequiresEditPassword
                              ? "sm:grid-cols-[minmax(0,1fr)_90px]"
                              : "sm:grid-cols-[minmax(0,1fr)_90px_auto]",
                          )}
                        >
                          <input
                            type="text"
                            value={service.name}
                            onChange={(e) => updateService(index, "name", e.target.value)}
                            readOnly={selectedClientRequiresEditPassword}
                            disabled={selectedClientRequiresEditPassword}
                            placeholder="nome"
                            className={cn(
                              "h-9 min-w-0 rounded border px-2 font-mono text-xs",
                              selectedClientRequiresEditPassword
                                ? "border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
                                : "border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900",
                            )}
                          />
                          <input
                            type="number"
                            value={service.port}
                            onChange={(e) => updateService(index, "port", e.target.value)}
                            readOnly={selectedClientRequiresEditPassword}
                            disabled={selectedClientRequiresEditPassword}
                            placeholder="porta"
                            className={cn(
                              "h-9 min-w-0 rounded border px-2 font-mono text-xs",
                              selectedClientRequiresEditPassword
                                ? "border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
                                : "border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900",
                            )}
                          />
                          {!selectedClientRequiresEditPassword && (
                            <button
                              type="button"
                              onClick={() => removeService(index)}
                              className="h-9 shrink-0 rounded border border-zinc-300 bg-white px-2 text-[11px] text-zinc-600 transition-colors hover:bg-red-50 hover:text-red-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-red-900/40 dark:hover:text-red-200"
                            >
                              Remover
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                    <span
                      className={cn(
                        "h-2 w-2 rounded-full",
                        selectedClient.status === "online"
                          ? "bg-emerald-500"
                          : "bg-zinc-400",
                      )}
                    />
                    Status: {selectedClient.status}
                  </div>

                  {saveError && (
                    <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-200">
                      {saveError}
                    </div>
                  )}
                  {saveSuccess && (
                    <div className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200">
                      Configurações salvas com sucesso.
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2">
                    {!selectedClientRequiresEditPassword && (
                      <>
                        <button
                          type="button"
                          onClick={handleSaveClick}
                          disabled={saving || !hasUnsavedChanges}
                          className="inline-flex h-9 items-center justify-center rounded bg-zinc-900 px-4 text-sm font-medium text-zinc-50 hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                        >
                          {saving ? "Salvando..." : "Salvar alterações"}
                        </button>
                        {hasUnsavedChanges && (
                          <button
                            type="button"
                            onClick={resetEditFormFromSaved}
                            disabled={saving}
                            className="inline-flex h-9 items-center justify-center rounded border border-zinc-300 bg-white px-4 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                          >
                            Desfazer alterações
                          </button>
                        )}
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setRightPanelView("request");
                        setRequestResult(null);
                        if (!selectedService && editServices[0]?.name) {
                          setSelectedService(editServices[0].name);
                        }
                      }}
                      disabled={selectedClient.status !== "online"}
                      className="inline-flex h-9 items-center justify-center rounded border border-zinc-300 bg-white px-4 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                    >
                      Enviar requisição
                    </button>
                  </div>
                </div>
              ) : selectedClient.status !== "online" ? (
                <div className="rounded border border-amber-200 bg-amber-50 px-3 py-6 text-center text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                  Este cliente está offline. Aguarde ele reconectar.
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-500">Cliente:</span>
                    <span className="text-sm font-medium">{editClientName || selectedClient.clientName}</span>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-zinc-500">Serviço</span>
                      <select
                        value={selectedService}
                        onChange={(e) => setSelectedService(e.target.value)}
                        className="h-9 rounded border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                      >
                        {editServices
                          .filter((service) => service.name.trim())
                          .map((service) => (
                            <option key={service.name} value={service.name}>
                              {service.name}:{service.port}
                            </option>
                          ))}
                      </select>
                    </label>

                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-zinc-500">Método</span>
                      <select
                        value={requestMethod}
                        onChange={(e) => setRequestMethod(e.target.value)}
                        className="h-9 rounded border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
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
                      className="h-9 rounded border border-zinc-300 bg-white px-2 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
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
                              requestResult.response.status >= 200 &&
                                requestResult.response.status < 300
                                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                                : requestResult.response.status >= 400
                                  ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
                                  : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
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

      {savePasswordOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 px-4">
          <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-lg dark:bg-zinc-950">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
              Confirmar senha do cliente
            </h2>
            <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
              Este cliente exige a senha definida no proxy (
              <code className="font-mono">CLIENT_PASSWORD</code>) para alterar
              nome ou portas expostas.
            </p>
            <label className="mt-4 flex flex-col gap-1">
              <span className="text-xs text-zinc-500">Senha do cliente</span>
              <input
                type="password"
                autoFocus
                value={editPassword}
                onChange={(e) => {
                  setEditPassword(e.target.value);
                  setSaveError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    void saveClientConfig(editPassword);
                  }
                }}
                className="h-9 rounded border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                placeholder="Digite a senha do cliente"
              />
            </label>
            {saveError && (
              <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-200">
                {saveError}
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  if (!saving) {
                    revertClientEdits();
                  }
                }}
                className="rounded border border-zinc-300 bg-white px-3 py-1.5 text-xs text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void saveClientConfig(editPassword)}
                className="rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-50 hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                {saving ? "Salvando..." : "Confirmar e salvar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
