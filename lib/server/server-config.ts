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
    return {
      ok: false,
      message: "Nome do servidor ou senha incorretos. Confira e tente novamente.",
    };
  }

  return { ok: true, serverName: normalized };
}

export async function serverRequiresPassword(serverName: string): Promise<boolean> {
  const normalized = normalizeServerName(serverName);
  const collection = await serverConfigsCollection();
  const existing = await collection.findOne({ _id: normalized });
  return Boolean(existing?.password?.trim());
}

export async function verifyServerPassword(
  serverName: string,
  password?: string,
): Promise<{ ok: boolean; message?: string }> {
  const normalized = normalizeServerName(serverName);
  const collection = await serverConfigsCollection();
  const existing = await collection.findOne({ _id: normalized });

  if (!existing?.password?.trim()) {
    return { ok: true };
  }

  const provided = password?.trim() ?? "";
  if (existing.password.trim() !== provided) {
    return { ok: false, message: "Senha inválida." };
  }

  return { ok: true };
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

/**
 * Define ou remove a senha do server.
 * Se já houver senha, `currentPassword` precisa bater.
 * `password` vazio remove a senha.
 */
export async function setServerPassword(
  serverName: string,
  password: string,
  currentPassword?: string,
): Promise<{ ok: boolean; message?: string; hasPassword?: boolean }> {
  const normalized = normalizeServerName(serverName);
  if (!normalized) {
    return { ok: false, message: "server_name é obrigatório." };
  }

  const collection = await serverConfigsCollection();
  const existing = await collection.findOne({ _id: normalized });
  if (!existing) {
    return { ok: false, message: "Servidor não encontrado." };
  }

  const hasPassword = Boolean(existing.password?.trim());
  if (hasPassword) {
    const provided = currentPassword?.trim() ?? "";
    if (existing.password!.trim() !== provided) {
      return { ok: false, message: "Senha atual inválida." };
    }
  }

  const nextPassword = password.trim();
  if (nextPassword) {
    await collection.updateOne(
      { _id: normalized },
      { $set: { password: nextPassword } },
    );
    return { ok: true, hasPassword: true };
  }

  await collection.updateOne(
    { _id: normalized },
    { $unset: { password: "" } },
  );
  return { ok: true, hasPassword: false };
}

/** Apaga o server e todos os dados relacionados (APIs, rotas, logs, clients). */
export async function deleteServerAndAllData(serverName: string): Promise<void> {
  const normalized = normalizeServerName(serverName);
  if (!normalized) return;

  const db = await getDb();
  const servers = await serverConfigsCollection();
  await Promise.all([
    db.collection("api_configs").deleteMany({ serverName: normalized }),
    db.collection("route_configs").deleteMany({ serverName: normalized }),
    db.collection("request_logs").deleteMany({ serverName: normalized }),
    db.collection("client_auth").deleteMany({ serverName: normalized }),
    db.collection("client_configs").deleteMany({ serverName: normalized }),
    servers.deleteOne({ _id: normalized }),
  ]);
}
