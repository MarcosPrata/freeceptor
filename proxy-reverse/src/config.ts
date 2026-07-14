import { writeFileSync, readFileSync, existsSync } from "fs";

export type LocalService = {
  name: string;
  port: number;
  host: string;
};

/** Flat config used by FreeceptorWebSocketClient (one connection). */
export type ProxyConfig = {
  clientId: string;
  clientName: string;
  clientPassword?: string;
  freeceptorUrl: string;
  serverName: string;
  serverPassword?: string;
  localServices: LocalService[];
  verbose: boolean;
  reconnectInterval: number;
};

/** Config for one server connection. */
export type ConnectionConfig = {
  serverName: string;
  serverPassword?: string;
  localServices: LocalService[];
};

/** Top-level agent config stored in agent-config.json. */
export type ProxyAgentConfig = {
  clientId: string;
  clientName: string;
  clientPassword?: string;
  freeceptorUrl: string;
  verbose: boolean;
  reconnectInterval: number;
  connections: ConnectionConfig[];
};

export function mergeToProxyConfig(
  global: Omit<ProxyAgentConfig, "connections">,
  connection: ConnectionConfig
): ProxyConfig {
  return {
    clientId: global.clientId,
    clientName: global.clientName,
    clientPassword: global.clientPassword,
    freeceptorUrl: global.freeceptorUrl,
    serverName: connection.serverName,
    serverPassword: connection.serverPassword,
    localServices: connection.localServices,
    verbose: global.verbose,
    reconnectInterval: global.reconnectInterval,
  };
}

function generateClientId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `client-${timestamp}-${random}`;
}

function parseLocalServices(value: string): LocalService[] {
  if (!value.trim()) return [];
  return value.split(",").flatMap((service) => {
    const parts = service.trim().split(":");
    if (parts.length < 2) return [];
    if (parts.length === 2) {
      return [{ name: parts[0], port: parseInt(parts[1], 10), host: "localhost" }];
    }
    return [{ name: parts[0], host: parts[1], port: parseInt(parts[2], 10) }];
  });
}

function migrateFromEnv(): ProxyAgentConfig {
  const get = (key: string, def = "") => process.env[key]?.trim() || def;
  const clientId = get("CLIENT_ID") || generateClientId();
  const serverName = get("SERVER_NAME");
  return {
    clientId,
    clientName: get("CLIENT_NAME") || clientId,
    clientPassword: get("CLIENT_PASSWORD") || undefined,
    freeceptorUrl: get("FREECEPTOR_URL"),
    verbose: get("VERBOSE", "false") === "true",
    reconnectInterval: parseInt(get("RECONNECT_INTERVAL", "5000"), 10),
    connections: serverName
      ? [
          {
            serverName,
            serverPassword: get("SERVER_PASSWORD") || undefined,
            localServices: parseLocalServices(get("LOCAL_SERVICES")),
          },
        ]
      : [],
  };
}

export function loadAgentConfig(configPath: string): ProxyAgentConfig {
  if (existsSync(configPath)) {
    try {
      return JSON.parse(readFileSync(configPath, "utf-8")) as ProxyAgentConfig;
    } catch {
      // fall through
    }
  }
  return migrateFromEnv();
}

export function saveAgentConfig(config: ProxyAgentConfig, configPath: string): void {
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

export function serializeLocalServices(services: LocalService[]): string {
  return services
    .map((s) =>
      s.host !== "localhost"
        ? `${s.name}:${s.host}:${s.port}`
        : `${s.name}:${s.port}`
    )
    .join(",");
}
