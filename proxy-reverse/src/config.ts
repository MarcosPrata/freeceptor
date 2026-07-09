export type ProxyConfig = {
  localPort: number;
  freeceptorUrl: string;
  serverName: string;
  serverPassword?: string;
  targetUrl: string;
  verbose: boolean;
};

function getEnvOrDefault(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

function getEnvOrThrow(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Environment variable ${key} is required`);
  }
  return value;
}

export function loadConfig(): ProxyConfig {
  return {
    localPort: parseInt(getEnvOrDefault("LOCAL_PORT", "8080"), 10),
    freeceptorUrl: getEnvOrThrow("FREECEPTOR_URL"),
    serverName: getEnvOrThrow("SERVER_NAME"),
    serverPassword: process.env.SERVER_PASSWORD,
    targetUrl: getEnvOrThrow("TARGET_URL"),
    verbose: getEnvOrDefault("VERBOSE", "false") === "true",
  };
}
