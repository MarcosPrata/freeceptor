import { getDb } from "@/lib/server/mongo";
import type { ProxyServiceInfo } from "@/types/proxy-client";

export type ClientConfigOverride = {
  serverName: string;
  clientId: string;
  clientName: string;
  localServices: ProxyServiceInfo[];
  updatedAt: string;
};

type ClientConfigDoc = {
  _id: string;
} & ClientConfigOverride;

async function collection() {
  const db = await getDb();
  return db.collection<ClientConfigDoc>("client_configs");
}

function buildId(serverName: string, clientId: string): string {
  return `${serverName}:${clientId}`;
}

function mapDoc(doc: ClientConfigDoc): ClientConfigOverride {
  const { _id, ...rest } = doc;
  void _id;
  return rest;
}

export async function getClientConfigOverride(
  serverName: string,
  clientId: string,
): Promise<ClientConfigOverride | null> {
  const col = await collection();
  const doc = await col.findOne({ _id: buildId(serverName, clientId) });
  return doc ? mapDoc(doc) : null;
}

export async function getClientConfigOverrides(
  serverName: string,
): Promise<Map<string, ClientConfigOverride>> {
  const col = await collection();
  const docs = await col.find({ serverName }).toArray();
  const map = new Map<string, ClientConfigOverride>();
  for (const doc of docs) {
    map.set(doc.clientId, mapDoc(doc));
  }
  return map;
}

export async function setClientConfigOverride(
  serverName: string,
  clientId: string,
  data: {
    clientName: string;
    localServices: ProxyServiceInfo[];
  },
): Promise<ClientConfigOverride> {
  const col = await collection();
  const id = buildId(serverName, clientId);
  const override: ClientConfigOverride = {
    serverName,
    clientId,
    clientName: data.clientName.trim(),
    localServices: data.localServices.map((service) => ({
      name: service.name.trim(),
      host: service.host.trim() || "localhost",
      port: Number(service.port),
    })),
    updatedAt: new Date().toISOString(),
  };

  await col.updateOne(
    { _id: id },
    { $set: { ...override, _id: id } },
    { upsert: true },
  );

  return override;
}
