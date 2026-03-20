import { getDb } from "@/lib/server/mongo";

export type ServerConfig = {
  serverName: string;
  password?: string;
};

type ServerConfigDoc = {
  _id: string;
  serverName: string;
  password?: string;
};

async function serverConfigsCollection() {
  const db = await getDb();
  return db.collection<ServerConfigDoc>("server_configs");
}

function normalizeServerName(serverName: string): string {
  return serverName.trim().toLowerCase();
}

export async function verifyOrCreateServerConfig(
  serverName: string,
  password?: string,
): Promise<{ ok: boolean; serverName?: string; message?: string }> {
  const normalized = normalizeServerName(serverName);
  if (!normalized) {
    return { ok: false, message: "server_name é obrigatório." };
  }

  const collection = await serverConfigsCollection();
  const existing = await collection.findOne({ _id: normalized });
  const expectedPassword = password?.trim() ?? "";

  if (!existing) {
    await collection.insertOne({
      _id: normalized,
      serverName: normalized,
      password: expectedPassword || undefined,
    });
    return { ok: true, serverName: normalized };
  }

  const currentPassword = existing.password?.trim() ?? "";
  if (currentPassword !== expectedPassword) {
    return { ok: false, message: "server_name ou senha inválidos." };
  }

  return { ok: true, serverName: normalized };
}

export async function ensureServerConfigExists(serverName: string): Promise<string> {
  const normalized = normalizeServerName(serverName);
  const collection = await serverConfigsCollection();
  await collection.updateOne(
    { _id: normalized },
    {
      $setOnInsert: {
        _id: normalized,
        serverName: normalized,
      },
    },
    { upsert: true },
  );
  return normalized;
}
