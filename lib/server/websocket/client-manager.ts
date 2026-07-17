import type { WebSocket } from "ws";
import type {
  ConnectedClient,
  ClientInfo,
  ProxyServiceInfo,
  WebSocketMessage,
  ResponseMessage,
  PendingRequest,
} from "./types";

class ClientManager {
  private clients: Map<string, ConnectedClient> = new Map();
  private pendingRequests: Map<string, PendingRequest> = new Map();
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
      this.clients.delete(key);
      this.notifyClientUpdate(serverName);
      console.log(`[WebSocket] Client unregistered: ${client.clientName} (${clientId})`);
    }
  }

  unregisterBySocket(socket: WebSocket): void {
    for (const [key, client] of this.clients.entries()) {
      if (client.socket === socket) {
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
