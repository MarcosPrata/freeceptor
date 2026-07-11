import { clientManager } from "@/lib/server/websocket";
import type { ClientInfo } from "@/lib/server/websocket";
import type { ProxyServiceInfo } from "@/types/proxy-client";
import { getClientConfigOverrides } from "./client-config";
import { getClientEditPasswordRequirements } from "./client-auth";

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
    localServices: override.localServices,
  };
}

export async function getMergedClientsByServer(
  serverName: string,
): Promise<ClientInfo[]> {
  const [clients, overrides] = await Promise.all([
    Promise.resolve(clientManager.getClientsByServer(serverName)),
    getClientConfigOverrides(serverName),
  ]);

  const passwordRequirements = await getClientEditPasswordRequirements(
    serverName,
    clients.map((client) => client.clientId),
  );

  return clients.map((client) => ({
    ...applyOverride(client, overrides.get(client.clientId)),
    requiresEditPassword: passwordRequirements.get(client.clientId) ?? false,
  }));
}

export async function getMergedClient(
  serverName: string,
  clientId: string,
): Promise<ClientInfo | undefined> {
  const clients = await getMergedClientsByServer(serverName);
  return clients.find((client) => client.clientId === clientId);
}
