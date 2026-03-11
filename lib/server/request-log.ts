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
};

let counter = 1;
const logs: ApiRequestLog[] = [];

export function addRequestLog(entry: Omit<ApiRequestLog, "id" | "timestamp">) {
  const log: ApiRequestLog = {
    id: counter++,
    timestamp: new Date().toISOString(),
    ...entry,
  };
  logs.unshift(log);
  // limita tamanho para não crescer infinito
  if (logs.length > 200) {
    logs.length = 200;
  }
}

export function getRequestLogs(): ApiRequestLog[] {
  return logs;
}

