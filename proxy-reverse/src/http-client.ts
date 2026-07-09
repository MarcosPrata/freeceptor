import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import type { ProxyConfig } from "./config.js";
import type { ProxyRequestMessage, ProxyResponseMessage } from "./types.js";
import { executeLocalRequest } from "./local-executor.js";

type HttpResponse = {
  status: number;
  body: unknown;
};

async function httpRequest(
  url: URL,
  method: string,
  body?: unknown
): Promise<HttpResponse> {
  const protocol = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = protocol.request(
      url,
      {
        method,
        headers: {
          "Content-Type": "application/json",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf-8");
          let parsed: unknown;
          try {
            parsed = JSON.parse(responseBody);
          } catch {
            parsed = responseBody;
          }
          resolve({
            status: res.statusCode ?? 500,
            body: parsed,
          });
        });
        res.on("error", reject);
      }
    );

    req.on("error", reject);

    if (body !== undefined) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

export class FreeceptorHttpClient {
  private isRunning = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor(private config: ProxyConfig) {}

  async start(): Promise<void> {
    if (this.isRunning) return;

    console.log("[Client] Registering with Freeceptor...");

    const registered = await this.register();
    if (!registered) {
      console.error("[Client] Failed to register. Retrying in 5 seconds...");
      setTimeout(() => this.start(), 5000);
      return;
    }

    console.log("[Client] Registration successful");
    this.isRunning = true;

    this.startHeartbeat();
    this.startPolling();
  }

  stop(): void {
    this.isRunning = false;

    if (this.pollInterval) {
      clearTimeout(this.pollInterval);
      this.pollInterval = null;
    }

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private async register(): Promise<boolean> {
    try {
      const url = new URL("/api/proxy/register", this.config.freeceptorUrl);

      const response = await httpRequest(url, "POST", {
        clientId: this.config.clientId,
        clientName: this.config.clientName,
        serverName: this.config.serverName,
        password: this.config.serverPassword,
        localServices: this.config.localServices,
      });

      if (response.status !== 200) {
        const errorBody = response.body as { error?: string };
        console.error(
          `[Client] Registration failed: ${errorBody.error || "Unknown error"}`
        );
        return false;
      }

      return true;
    } catch (err) {
      console.error(
        `[Client] Registration error: ${err instanceof Error ? err.message : err}`
      );
      return false;
    }
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(async () => {
      try {
        const url = new URL("/api/proxy/heartbeat", this.config.freeceptorUrl);

        const response = await httpRequest(url, "POST", {
          clientId: this.config.clientId,
          serverName: this.config.serverName,
        });

        if (response.status !== 200) {
          if (this.config.verbose) {
            console.log("[Heartbeat] Failed, will re-register");
          }
          await this.register();
        } else if (this.config.verbose) {
          console.log("[Heartbeat] OK");
        }
      } catch (err) {
        if (this.config.verbose) {
          console.error(
            `[Heartbeat] Error: ${err instanceof Error ? err.message : err}`
          );
        }
      }
    }, 30000);
  }

  private startPolling(): void {
    const poll = async () => {
      if (!this.isRunning) return;

      try {
        const commands = await this.fetchCommands();

        for (const command of commands) {
          await this.processCommand(command);
        }
      } catch (err) {
        if (this.config.verbose) {
          console.error(
            `[Poll] Error: ${err instanceof Error ? err.message : err}`
          );
        }
      }

      if (this.isRunning) {
        this.pollInterval = setTimeout(poll, 1000);
      }
    };

    poll();
  }

  private async fetchCommands(): Promise<ProxyRequestMessage[]> {
    const url = new URL("/api/proxy/commands", this.config.freeceptorUrl);
    url.searchParams.set("clientId", this.config.clientId);
    url.searchParams.set("serverName", this.config.serverName);

    const response = await httpRequest(url, "GET");

    if (response.status !== 200) {
      return [];
    }

    const body = response.body as { commands?: ProxyRequestMessage[] };
    return body.commands ?? [];
  }

  private async processCommand(command: ProxyRequestMessage): Promise<void> {
    console.log(
      `[Request] ${command.method} ${command.serviceName}${command.path} (id: ${command.requestId})`
    );

    const response = await executeLocalRequest(this.config, command);

    console.log(
      `[Response] ${command.requestId} -> ${response.status}${response.error ? ` (error: ${response.error})` : ""}`
    );

    await this.sendResponse(response);
  }

  private async sendResponse(response: ProxyResponseMessage): Promise<void> {
    try {
      const url = new URL("/api/proxy/response", this.config.freeceptorUrl);

      await httpRequest(url, "POST", {
        requestId: response.requestId,
        status: response.status,
        headers: response.headers,
        body: response.body,
        error: response.error,
      });
    } catch (err) {
      console.error(
        `[Response] Failed to send: ${err instanceof Error ? err.message : err}`
      );
    }
  }
}
