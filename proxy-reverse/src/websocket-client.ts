import WebSocket from "ws";
import type { ProxyConfig } from "./config.js";
import type {
  WebSocketMessage,
  RegisterMessage,
  HeartbeatMessage,
  ProxyRequestMessage,
} from "./types.js";
import { executeLocalRequest } from "./local-executor.js";

export class FreeceptorWebSocketClient {
  private ws: WebSocket | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private isConnecting = false;
  private shouldReconnect = true;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;

  constructor(private config: ProxyConfig) {}

  connect(): void {
    if (this.isConnecting || this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    this.isConnecting = true;
    const wsUrl = this.buildWebSocketUrl();

    if (this.config.verbose) {
      console.log(`[WebSocket] Connecting to ${wsUrl}...`);
    }

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      this.isConnecting = false;
      console.error(`[WebSocket] Failed to create connection: ${err instanceof Error ? err.message : err}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      this.isConnecting = false;
      this.reconnectAttempts = 0;
      console.log("[WebSocket] Connected to Freeceptor");
      this.register();
      this.startHeartbeat();
    });

    this.ws.on("message", (data: WebSocket.RawData) => {
      this.handleMessage(data.toString());
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      this.isConnecting = false;
      console.log(
        `[WebSocket] Disconnected (code: ${code}, reason: ${reason.toString() || "none"})`
      );
      this.stopHeartbeat();
      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      this.isConnecting = false;
      console.error(`[WebSocket] Error: ${err.message}`);
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.stopHeartbeat();

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close(1000, "Client disconnecting");
      this.ws = null;
    }
  }

  private buildWebSocketUrl(): string {
    const baseUrl = this.config.freeceptorUrl
      .replace(/^http:/, "ws:")
      .replace(/^https:/, "wss:");
    
    const wsPath = "/ws";
    return `${baseUrl}${wsPath}`;
  }

  private register(): void {
    const message: RegisterMessage = {
      type: "register",
      clientId: this.config.clientId,
      clientName: this.config.clientName,
      serverName: this.config.serverName,
      password: this.config.serverPassword,
      localServices: this.config.localServices,
    };

    this.send(message);
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const message: HeartbeatMessage = {
        type: "heartbeat",
        clientId: this.config.clientId,
        timestamp: new Date().toISOString(),
      };
      this.send(message);

      if (this.config.verbose) {
        console.log("[Heartbeat] Sent");
      }
    }, 30000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;

    this.reconnectAttempts++;

    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      console.error(`[WebSocket] Max reconnect attempts (${this.maxReconnectAttempts}) reached. Giving up.`);
      return;
    }

    const delay = Math.min(
      this.config.reconnectInterval * Math.pow(2, this.reconnectAttempts - 1),
      60000
    );

    console.log(
      `[WebSocket] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`
    );

    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private send(message: WebSocketMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else if (this.config.verbose) {
      console.log("[WebSocket] Cannot send - not connected");
    }
  }

  private async handleMessage(data: string): Promise<void> {
    let message: WebSocketMessage;

    try {
      message = JSON.parse(data) as WebSocketMessage;
    } catch {
      console.error("[WebSocket] Failed to parse message:", data.substring(0, 100));
      return;
    }

    if (this.config.verbose) {
      console.log(`[WebSocket] Received: ${message.type}`);
    }

    switch (message.type) {
      case "welcome":
        console.log("[WebSocket] Server welcomed connection");
        break;

      case "register_ack":
        if (message.success) {
          console.log("[WebSocket] Registration successful");
        } else {
          console.error(`[WebSocket] Registration failed: ${message.message}`);
          this.shouldReconnect = false;
          this.disconnect();
        }
        break;

      case "heartbeat_ack":
        if (this.config.verbose) {
          console.log("[Heartbeat] Acknowledged");
        }
        break;

      case "request":
        await this.handleRequest(message as ProxyRequestMessage);
        break;

      case "error":
        console.error(`[WebSocket] Server error: ${message.message} (${message.code})`);
        break;

      default:
        if (this.config.verbose) {
          console.log(`[WebSocket] Unknown message type: ${(message as WebSocketMessage).type}`);
        }
    }
  }

  private async handleRequest(request: ProxyRequestMessage): Promise<void> {
    console.log(
      `[Request] ${request.method} ${request.serviceName}${request.path} (id: ${request.requestId})`
    );

    const response = await executeLocalRequest(this.config, request);

    console.log(
      `[Response] ${request.requestId} -> ${response.status}${response.error ? ` (error: ${response.error})` : ""}`
    );

    this.send(response as unknown as WebSocketMessage);
  }
}
