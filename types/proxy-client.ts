export type ProxyClientInfo = {
  clientId: string;
  clientName: string;
  serverName: string;
  localServices: ProxyServiceInfo[];
  connectedAt: string;
  lastHeartbeat: string;
  status: "online" | "offline";
  requiresEditPassword?: boolean;
  version?: string;
};

export type ProxyServiceInfo = {
  name: string;
  port: number;
  host: string;
};

export type ProxyWebSocketMessage =
  | ProxyRegisterMessage
  | ProxyRegisterAckMessage
  | ProxyHeartbeatMessage
  | ProxyHeartbeatAckMessage
  | ProxyRequestMessage
  | ProxyResponseMessage
  | ProxyErrorMessage;

export type ProxyRegisterMessage = {
  type: "register";
  clientId: string;
  clientName: string;
  serverName: string;
  password?: string;
  clientPassword?: string;
  localServices: ProxyServiceInfo[];
  version?: string;
};

export type ProxyRegisterAckMessage = {
  type: "register_ack";
  success: boolean;
  message?: string;
};

export type ProxyHeartbeatMessage = {
  type: "heartbeat";
  clientId: string;
  timestamp: string;
};

export type ProxyHeartbeatAckMessage = {
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

export type ProxyErrorMessage = {
  type: "error";
  requestId?: string;
  message: string;
  code: string;
};
