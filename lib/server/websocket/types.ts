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
  | ResponseMessage
  | ErrorMessage
  | ClientListMessage;

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
  body: unknown;
};

export type ResponseMessage = {
  type: "response";
  requestId: string;
  status: number;
  headers: Record<string, string>;
  body: unknown;
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

export type PendingRequest = {
  requestId: string;
  resolve: (response: ResponseMessage) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};
