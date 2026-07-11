export type ProxyServiceInfo = {
  name: string;
  port: number;
  host: string;
};

export type WebSocketMessage =
  | WelcomeMessage
  | RegisterMessage
  | RegisterAckMessage
  | HeartbeatMessage
  | HeartbeatAckMessage
  | ProxyRequestMessage
  | ProxyResponseMessage
  | ErrorMessage;

export type WelcomeMessage = {
  type: "welcome";
  message: string;
  timestamp: string;
};

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

export type ProxyRequestMessage = {
  type: "request";
  requestId: string;
  targetClientId: string;
  serviceName: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
};

export type ProxyResponseMessage = {
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
