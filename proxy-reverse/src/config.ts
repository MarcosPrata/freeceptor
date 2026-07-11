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

export type LocalService = {
  name: string;
  port: number;
  host: string;
};

function getEnvOrDefault(key: string, defaultValue: string): string {
  const value = process.env[key];
  return value && value.trim() ? value.trim() : defaultValue;
}

function getEnvOrThrow(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Environment variable ${key} is required`);
  }
  return value;
}

function generateClientId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `client-${timestamp}-${random}`;
}

function parseLocalServices(value: string): LocalService[] {
  if (!value.trim()) return [];
  
  return value.split(",").map((service) => {
    const parts = service.trim().split(":");
    if (parts.length < 2) {
      throw new Error(
        `Invalid service format: ${service}. Expected: name:port or name:host:port`
      );
    }
    
    if (parts.length === 2) {
      return {
        name: parts[0],
        port: parseInt(parts[1], 10),
        host: "localhost",
      };
    }
    
    return {
      name: parts[0],
      host: parts[1],
      port: parseInt(parts[2], 10),
    };
  });
}

export function loadConfig(): ProxyConfig {
  const clientId = getEnvOrDefault("CLIENT_ID", generateClientId());
  
  return {
    clientId,
    clientName: getEnvOrDefault("CLIENT_NAME", clientId),
    clientPassword: process.env.CLIENT_PASSWORD?.trim() || undefined,
    freeceptorUrl: getEnvOrThrow("FREECEPTOR_URL"),
    serverName: getEnvOrThrow("SERVER_NAME"),
    serverPassword: process.env.SERVER_PASSWORD,
    localServices: parseLocalServices(getEnvOrDefault("LOCAL_SERVICES", "")),
    verbose: getEnvOrDefault("VERBOSE", "false") === "true",
    reconnectInterval: parseInt(getEnvOrDefault("RECONNECT_INTERVAL", "5000"), 10),
  };
}
