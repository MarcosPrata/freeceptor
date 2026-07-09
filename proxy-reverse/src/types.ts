export type ProxyClientInfo = {
  clientId: string;
  clientName: string;
  serverName: string;
  localServices: ProxyServiceInfo[];
  connectedAt: string;
  lastHeartbeat: string;
  status: "online" | "offline";
};

export type ProxyServiceInfo = {
  name: string;
  port: number;
  host: string;
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
