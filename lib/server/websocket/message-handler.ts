import type { WebSocket } from "ws";
import { clientManager } from "./client-manager";
import { setClientAuth } from "../client-auth";
import { clearClientConfigOverride } from "../client-config";
import { verifyOrCreateServerConfig } from "../server-config";
import type {
  WebSocketMessage,
  RegisterMessage,
  HeartbeatMessage,
  ResponseMessage,
  RegisterAckMessage,
  HeartbeatAckMessage,
  ErrorMessage,
} from "./types";

function send(socket: WebSocket, message: WebSocketMessage): void {
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(message));
  }
}

function sendError(socket: WebSocket, code: string, message: string, requestId?: string): void {
  const errorMsg: ErrorMessage = {
    type: "error",
    code,
    message,
    requestId,
  };
  send(socket, errorMsg);
}

async function handleRegister(socket: WebSocket, message: RegisterMessage): Promise<void> {
  const { clientId, clientName, serverName, password, clientPassword, localServices } = message;

  if (!clientId || !serverName) {
    const ack: RegisterAckMessage = {
      type: "register_ack",
      success: false,
      message: "clientId and serverName are required",
    };
    send(socket, ack);
    return;
  }

  const serverResult = await verifyOrCreateServerConfig(serverName, password);
  
  if (!serverResult.ok) {
    const ack: RegisterAckMessage = {
      type: "register_ack",
      success: false,
      message: serverResult.message || "Invalid server credentials",
    };
    send(socket, ack);
    return;
  }

  // Persiste a senha ANTES de registrar/notificar o SSE — senão a UI recebe
  // requiresEditPassword: false e só atualiza no próximo disconnect/reconnect.
  await Promise.all([
    setClientAuth(serverName, clientId, clientPassword),
    // Descarta override antigo do Freeceptor — o client conectado é a fonte da verdade.
    clearClientConfigOverride(serverName, clientId),
  ]);

  clientManager.registerClient(
    socket,
    clientId,
    clientName || clientId,
    serverName,
    localServices || []
  );

  const ack: RegisterAckMessage = {
    type: "register_ack",
    success: true,
  };
  send(socket, ack);
}

function handleHeartbeat(socket: WebSocket, message: HeartbeatMessage): void {
  const { clientId } = message;

  let found = false;
  for (const client of clientManager.getAllClients()) {
    if (client.clientId === clientId) {
      clientManager.updateHeartbeat(client.serverName, clientId);
      found = true;
      break;
    }
  }

  if (!found) {
    sendError(socket, "CLIENT_NOT_FOUND", "Client not registered. Please register first.");
    return;
  }

  const ack: HeartbeatAckMessage = {
    type: "heartbeat_ack",
    timestamp: new Date().toISOString(),
  };
  send(socket, ack);
}

function handleResponse(socket: WebSocket, message: ResponseMessage): void {
  const resolved = clientManager.resolvePendingRequest(message);
  
  if (!resolved) {
    console.log(`[WebSocket] Received response for unknown request: ${message.requestId}`);
  }
}

export async function handleMessage(socket: WebSocket, data: string): Promise<void> {
  let message: WebSocketMessage;

  try {
    message = JSON.parse(data) as WebSocketMessage;
  } catch {
    sendError(socket, "INVALID_JSON", "Invalid JSON message");
    return;
  }

  try {
    switch (message.type) {
      case "register":
        await handleRegister(socket, message);
        break;

      case "heartbeat":
        handleHeartbeat(socket, message);
        break;

      case "response":
        handleResponse(socket, message);
        break;

      default:
        sendError(socket, "UNKNOWN_MESSAGE_TYPE", `Unknown message type: ${(message as WebSocketMessage).type}`);
    }
  } catch (err) {
    console.error("[WebSocket] Error handling message:", err);
    sendError(socket, "INTERNAL_ERROR", "Internal server error");
  }
}

export function handleDisconnect(socket: WebSocket): void {
  clientManager.unregisterBySocket(socket);
}
