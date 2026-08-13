import type { WebSocket } from "ws";

export type ProxyServiceInfo = {
  name: string;
  port: number;
  host: string;
};

export type ConnectedClient = {
  clientId: string;
  clientName: string;
  serverName: string;
  localServices: ProxyServiceInfo[];
  connectedAt: Date;
  lastHeartbeat: Date;
  socket: WebSocket;
};

export type ClientInfo = {
  clientId: string;
  clientName: string;
  serverName: string;
  localServices: ProxyServiceInfo[];
  connectedAt: string;
  lastHeartbeat: string;
  status: "online" | "offline";
  requiresEditPassword?: boolean;
};

export type WebSocketMessage =
  | RegisterMessage
  | RegisterAckMessage
  | HeartbeatMessage
  | HeartbeatAckMessage
  | RequestMessage
  | RequestAbortMessage
  | ResponseMessage
  | ResponseStartMessage
  | ResponseChunkMessage
  | ResponseEndMessage
  | ErrorMessage
  | ClientListMessage
  | ConfigUpdateMessage;

export type RegisterMessage = {
  type: "register";
  clientId: string;
  clientName: string;
  serverName: string;
  password?: string;
  clientPassword?: string;
  localServices: ProxyServiceInfo[];
};

export type RegisterAckMessage = {
  type: "register_ack";
  success: boolean;
  message?: string;
};

export type HeartbeatMessage = {
  type: "heartbeat";
  clientId: string;
  timestamp: string;
};

export type HeartbeatAckMessage = {
  type: "heartbeat_ack";
  timestamp: string;
};

export type RequestMessage = {
  type: "request";
  requestId: string;
  targetClientId: string;
  serviceName: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  /**
   * Request body. When `bodyEncoding` is `"base64"`, this is a base64 string of
   * the raw bytes (preserves multipart, urlencoded, binary, exact JSON, etc.).
   * Legacy clients may still receive parsed JSON/objects without encoding.
   */
  body: unknown;
  /** How to interpret `body`. Omit / undefined = legacy JSON/text payload. */
  bodyEncoding?: "base64";
  /**
   * When true the agent must not buffer the local response: emit `response_start`
   * as soon as headers arrive, then `response_chunk` per body chunk, then
   * `response_end`. Required for SSE (`text/event-stream`) — those streams never
   * `end`, so the unary `response` message can never be sent.
   */
  stream?: boolean;
};

/** Phone hung up (or the Next.js request aborted). Agent must destroy the local HTTP call. */
export type RequestAbortMessage = {
  type: "request_abort";
  requestId: string;
};

export type ResponseMessage = {
  type: "response";
  requestId: string;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  error?: string;
};

/** First frame of a streamed proxy response (headers only, body follows as chunks). */
export type ResponseStartMessage = {
  type: "response_start";
  requestId: string;
  status: number;
  headers: Record<string, string>;
};

/** Raw body bytes of a streamed proxy response, base64-encoded. */
export type ResponseChunkMessage = {
  type: "response_chunk";
  requestId: string;
  data: string;
};

/** Stream finished (Nest closed, agent aborted, or local error). */
export type ResponseEndMessage = {
  type: "response_end";
  requestId: string;
  error?: string;
};

export type ErrorMessage = {
  type: "error";
  requestId?: string;
  message: string;
  code: string;
};

export type ClientListMessage = {
  type: "client_list";
  clients: ClientInfo[];
};

/** Freeceptor UI → client: aplica nome/serviços sem precisar editar no agent. */
export type ConfigUpdateMessage = {
  type: "config_update";
  clientName: string;
  localServices: ProxyServiceInfo[];
};

export type PendingRequest = {
  requestId: string;
  resolve: (response: ResponseMessage) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};
