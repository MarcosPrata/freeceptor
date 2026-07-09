import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { Server as HttpServer } from "http";
import { handleMessage, handleDisconnect } from "./message-handler";
import { clientManager } from "./client-manager";

let wss: WebSocketServer | null = null;
let cleanupInterval: NodeJS.Timeout | null = null;

export type WebSocketServerConfig = {
  port?: number;
  server?: HttpServer;
  path?: string;
};

export function createWebSocketServer(config: WebSocketServerConfig = {}): WebSocketServer {
  if (wss) {
    console.log("[WebSocket] Server already running");
    return wss;
  }

  const { port, server, path = "/ws" } = config;

  if (server) {
    wss = new WebSocketServer({ server, path });
    console.log(`[WebSocket] Server attached to HTTP server at path ${path}`);
  } else {
    const wsPort = port || parseInt(process.env.WS_PORT || "3002", 10);
    wss = new WebSocketServer({ port: wsPort, path });
    console.log(`[WebSocket] Server listening on port ${wsPort}${path}`);
  }

  wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const clientIp = request.socket.remoteAddress || "unknown";
    console.log(`[WebSocket] New connection from ${clientIp}`);

    socket.on("message", async (data: Buffer) => {
      try {
        await handleMessage(socket, data.toString());
      } catch (err) {
        console.error("[WebSocket] Error processing message:", err);
      }
    });

    socket.on("close", (code: number, reason: Buffer) => {
      console.log(`[WebSocket] Connection closed (code: ${code}, reason: ${reason.toString()})`);
      handleDisconnect(socket);
    });

    socket.on("error", (err: Error) => {
      console.error("[WebSocket] Socket error:", err.message);
    });

    socket.send(JSON.stringify({
      type: "welcome",
      message: "Connected to Freeceptor WebSocket server",
      timestamp: new Date().toISOString(),
    }));
  });

  wss.on("error", (err: Error) => {
    console.error("[WebSocket] Server error:", err);
  });

  cleanupInterval = setInterval(() => {
    clientManager.cleanupStaleClients();
  }, 60000);

  return wss;
}

export function getWebSocketServer(): WebSocketServer | null {
  return wss;
}

export function closeWebSocketServer(): Promise<void> {
  return new Promise((resolve) => {
    if (cleanupInterval) {
      clearInterval(cleanupInterval);
      cleanupInterval = null;
    }

    if (!wss) {
      resolve();
      return;
    }

    for (const client of wss.clients) {
      try {
        client.close(1001, "Server shutting down");
      } catch {
        // Ignore close errors
      }
    }

    wss.close((err) => {
      if (err) {
        console.error("[WebSocket] Error closing server:", err);
      } else {
        console.log("[WebSocket] Server closed");
      }
      wss = null;
      resolve();
    });
  });
}

export { clientManager };
