import type { WebSocket } from "ws";
import type {
  ConnectedClient,
  ClientInfo,
  ProxyServiceInfo,
  WebSocketMessage,
  ResponseMessage,
  ResponseStartMessage,
  ResponseChunkMessage,
  ResponseEndMessage,
  PendingRequest,
} from "./types";
import { appendLiveStreamChunk, closeLiveStream } from "../live-streams";

type PendingStream = {
  requestId: string;
  serverName: string;
  clientId: string;
  clientKey: string;
  started: boolean;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  body: ReadableStream<Uint8Array>;
  startTimeout: NodeJS.Timeout;
  resolveStart: (value: {
    status: number;
    headers: Record<string, string>;
    body: ReadableStream<Uint8Array>;
  }) => void;
  rejectStart: (error: Error) => void;
};

class ClientManager {
  private clients: Map<string, ConnectedClient> = new Map();
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private pendingStreams: Map<string, PendingStream> = new Map();
  private clientUpdateListeners: Set<(serverName: string) => void> = new Set();

  private buildClientKey(serverName: string, clientId: string): string {
    return `${serverName}:${clientId}`;
  }

  registerClient(
    socket: WebSocket,
    clientId: string,
    clientName: string,
    serverName: string,
    localServices: ProxyServiceInfo[]
  ): ConnectedClient {
    const key = this.buildClientKey(serverName, clientId);
    
    const existingClient = this.clients.get(key);
    if (existingClient && existingClient.socket !== socket) {
      try {
        existingClient.socket.close(1000, "Replaced by new connection");
      } catch {
        // Ignore close errors
      }
    }

    const client: ConnectedClient = {
      clientId,
      clientName,
      serverName,
      localServices,
      connectedAt: existingClient?.connectedAt ?? new Date(),
      lastHeartbeat: new Date(),
      socket,
    };

    this.clients.set(key, client);
    this.notifyClientUpdate(serverName);

    console.log(`[WebSocket] Client registered: ${clientName} (${clientId}) for server ${serverName}`);

    return client;
  }

  unregisterClient(serverName: string, clientId: string): void {
    const key = this.buildClientKey(serverName, clientId);
    const client = this.clients.get(key);
    
    if (client) {
      this.abortStreamsForClient(serverName, clientId);
      this.clients.delete(key);
      this.notifyClientUpdate(serverName);
      console.log(`[WebSocket] Client unregistered: ${client.clientName} (${clientId})`);
    }
  }

  unregisterBySocket(socket: WebSocket): void {
    for (const [key, client] of this.clients.entries()) {
      if (client.socket === socket) {
        this.abortStreamsForClient(client.serverName, client.clientId);
        this.clients.delete(key);
        this.notifyClientUpdate(client.serverName);
        console.log(`[WebSocket] Client disconnected: ${client.clientName} (${client.clientId})`);
        break;
      }
    }
  }

  updateHeartbeat(serverName: string, clientId: string): boolean {
    const key = this.buildClientKey(serverName, clientId);
    const client = this.clients.get(key);
    
    if (client) {
      client.lastHeartbeat = new Date();
      return true;
    }
    
    return false;
  }

  updateClientConfig(
    serverName: string,
    clientId: string,
    update: { clientName: string; localServices: ProxyServiceInfo[] },
  ): boolean {
    const client = this.getClient(serverName, clientId);
    if (!client) return false;

    client.clientName = update.clientName;
    client.localServices = update.localServices;
    this.notifyClientUpdate(serverName);
    return true;
  }

  getClient(serverName: string, clientId: string): ConnectedClient | undefined {
    const key = this.buildClientKey(serverName, clientId);
    return this.clients.get(key);
  }

  getClientsByServer(serverName: string): ClientInfo[] {
    const result: ClientInfo[] = [];
    
    for (const client of this.clients.values()) {
      if (client.serverName === serverName) {
        result.push(this.toClientInfo(client));
      }
    }

    return result.sort((a, b) => 
      new Date(b.connectedAt).getTime() - new Date(a.connectedAt).getTime()
    );
  }

  disconnectAllForServer(serverName: string): void {
    const normalized = serverName.trim().toLowerCase();
    let removed = false;

    for (const [key, client] of this.clients.entries()) {
      if (client.serverName.trim().toLowerCase() !== normalized) continue;
      this.abortStreamsForClient(client.serverName, client.clientId);
      try {
        client.socket.close(1000, "Server deleted");
      } catch {
        // ignore
      }
      this.clients.delete(key);
      removed = true;
    }

    if (removed) {
      this.notifyClientUpdate(normalized);
    }
  }

  getAllClients(): ClientInfo[] {
    return Array.from(this.clients.values()).map(this.toClientInfo);
  }

  private toClientInfo(client: ConnectedClient): ClientInfo {
    const isOnline = client.socket.readyState === 1; // WebSocket.OPEN
    
    return {
      clientId: client.clientId,
      clientName: client.clientName,
      serverName: client.serverName,
      localServices: client.localServices,
      connectedAt: client.connectedAt.toISOString(),
      lastHeartbeat: client.lastHeartbeat.toISOString(),
      status: isOnline ? "online" : "offline",
    };
  }

  sendToClient(serverName: string, clientId: string, message: WebSocketMessage): boolean {
    const client = this.getClient(serverName, clientId);
    
    if (!client || client.socket.readyState !== 1) {
      return false;
    }

    try {
      client.socket.send(JSON.stringify(message));
      return true;
    } catch (err) {
      console.error(`[WebSocket] Failed to send message to ${clientId}:`, err);
      return false;
    }
  }

  broadcastToServer(serverName: string, message: WebSocketMessage): void {
    for (const client of this.clients.values()) {
      if (client.serverName === serverName && client.socket.readyState === 1) {
        try {
          client.socket.send(JSON.stringify(message));
        } catch {
          // Ignore send errors for broadcast
        }
      }
    }
  }

  registerPendingRequest(
    requestId: string,
    timeoutMs: number = 30000
  ): Promise<ResponseMessage> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error("Request timeout"));
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        requestId,
        resolve,
        reject,
        timeout,
      });
    });
  }

  resolvePendingRequest(response: ResponseMessage): boolean {
    const pending = this.pendingRequests.get(response.requestId);
    
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(response.requestId);
      pending.resolve(response);
      return true;
    }
    
    return false;
  }

  /**
   * Waits for `response_start` (headers), then the caller pipes `body`.
   * Chunks / end arrive later via handleResponseChunk / handleResponseEnd.
   * `timeoutMs` only covers time-to-headers, not the lifetime of an SSE stream.
   */
  registerPendingStream(
    requestId: string,
    client: { serverName: string; clientId: string },
    timeoutMs: number = 30000,
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    body: ReadableStream<Uint8Array>;
  }> {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();

    return new Promise((resolve, reject) => {
      const startTimeout = setTimeout(() => {
        const pending = this.pendingStreams.get(requestId);
        if (!pending || pending.started) return;
        this.pendingStreams.delete(requestId);
        this.sendToClient(pending.serverName, pending.clientId, {
          type: "request_abort",
          requestId,
        });
        void writer.abort().catch(() => undefined);
        reject(new Error("Request timeout"));
      }, timeoutMs);

      this.pendingStreams.set(requestId, {
        requestId,
        serverName: client.serverName,
        clientId: client.clientId,
        clientKey: this.buildClientKey(client.serverName, client.clientId),
        started: false,
        writer,
        body: readable,
        startTimeout,
        resolveStart: resolve,
        rejectStart: reject,
      });
    });
  }

  handleResponseStart(message: ResponseStartMessage): boolean {
    const pending = this.pendingStreams.get(message.requestId);
    if (!pending || pending.started) return false;

    pending.started = true;
    clearTimeout(pending.startTimeout);
    pending.resolveStart({
      status: message.status,
      headers: message.headers,
      body: pending.body,
    });
    return true;
  }

  handleResponseChunk(message: ResponseChunkMessage): boolean {
    const pending = this.pendingStreams.get(message.requestId);
    if (!pending?.started) return false;
    try {
      const bytes = Buffer.from(message.data, "base64");
      appendLiveStreamChunk(message.requestId, bytes);
      void pending.writer.write(bytes).catch(() => {
        this.abortStream(message.requestId);
      });
      return true;
    } catch {
      return false;
    }
  }

  handleResponseEnd(message: ResponseEndMessage): boolean {
    const pending = this.pendingStreams.get(message.requestId);
    if (!pending) return false;
    this.pendingStreams.delete(message.requestId);
    clearTimeout(pending.startTimeout);
    closeLiveStream(message.requestId, message.error);

    if (!pending.started) {
      pending.rejectStart(new Error(message.error || "Stream ended before headers"));
      void pending.writer.abort().catch(() => undefined);
      return true;
    }

    if (message.error) {
      void pending.writer.abort().catch(() => undefined);
    } else {
      void pending.writer.close().catch(() => undefined);
    }
    return true;
  }

  abortStream(requestId: string): void {
    const pending = this.pendingStreams.get(requestId);
    if (!pending) {
      closeLiveStream(requestId);
      return;
    }
    this.pendingStreams.delete(requestId);
    clearTimeout(pending.startTimeout);
    closeLiveStream(requestId);
    this.sendToClient(pending.serverName, pending.clientId, {
      type: "request_abort",
      requestId,
    });
    if (!pending.started) {
      pending.rejectStart(new Error("Aborted"));
    }
    void pending.writer.abort().catch(() => undefined);
  }

  abortStreamsForClient(serverName: string, clientId: string): void {
    const key = this.buildClientKey(serverName, clientId);
    for (const [requestId, pending] of [...this.pendingStreams.entries()]) {
      if (pending.clientKey === key) {
        this.abortStream(requestId);
      }
    }
  }

  onClientUpdate(listener: (serverName: string) => void): () => void {
    this.clientUpdateListeners.add(listener);
    return () => this.clientUpdateListeners.delete(listener);
  }

  private notifyClientUpdate(serverName: string): void {
    for (const listener of this.clientUpdateListeners) {
      try {
        listener(serverName);
      } catch {
        // Ignore listener errors
      }
    }
  }

  cleanupStaleClients(maxAgeMs: number = 120000): void {
    const now = Date.now();
    
    for (const [key, client] of this.clients.entries()) {
      const age = now - client.lastHeartbeat.getTime();
      
      if (age > maxAgeMs || client.socket.readyState !== 1) {
        try {
          client.socket.close(1000, "Stale connection");
        } catch {
          // Ignore close errors
        }
        this.clients.delete(key);
        this.notifyClientUpdate(client.serverName);
        console.log(`[WebSocket] Cleaned up stale client: ${client.clientName}`);
      }
    }
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __freeceptorClientManager: ClientManager | undefined;
}

// Em dev, o HMR reavalia o módulo mas reusa a instância em globalThis.
// Sem atualizar o prototype, métodos novos (ex.: updateClientConfig) ficam "missing".
const existingManager = globalThis.__freeceptorClientManager;
if (existingManager) {
  Object.setPrototypeOf(existingManager, ClientManager.prototype);
  globalThis.__freeceptorClientManager = existingManager;
} else {
  globalThis.__freeceptorClientManager = new ClientManager();
}

export const clientManager = globalThis.__freeceptorClientManager;
