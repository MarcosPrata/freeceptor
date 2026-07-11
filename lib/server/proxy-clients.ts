import { clientManager } from "@/lib/server/websocket";
import type { ClientInfo } from "@/lib/server/websocket";
import type { ProxyServiceInfo } from "@/types/proxy-client";
import { getClientConfigOverrides } from "./client-config";

function applyOverride(
  client: ClientInfo,
  override?: {
    clientName: string;
    localServices: ProxyServiceInfo[];
  },
): ClientInfo {
  if (!override) return client;
  return {
    ...client,
    clientName: override.clientName || client.clientName,
    localServices:
      override.localServices.length > 0
        ? override.localServices
        : client.localServices,
  };
}

export async function getMergedClientsByServer(
  serverName: string,
): Promise<ClientInfo[]> {
  const [clients, overrides] = await Promise.all([
    Promise.resolve(clientManager.getClientsByServer(serverName)),
    getClientConfigOverrides(serverName),
  ]);

  return clients.map((client) =>
    applyOverride(client, overrides.get(client.clientId)),
  );
}

export async function getMergedClient(
  serverName: string,
  clientId: string,
): Promise<ClientInfo | undefined> {
  const clients = await getMergedClientsByServer(serverName);
  return clients.find((client) => client.clientId === clientId);
}
