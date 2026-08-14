import { getDb } from "@/lib/server/mongo";

export type DisplayBodyMode = "table" | "bulk";

export type ServerDisplaySettings = {
  displayBodyMode: DisplayBodyMode;
  displayJsonCollapsed: boolean;
};

export const DEFAULT_DISPLAY_SETTINGS: ServerDisplaySettings = {
  displayBodyMode: "bulk",
  displayJsonCollapsed: true,
};

export type ServerConfig = {
  serverName: string;
  password?: string;
  displayBodyMode?: DisplayBodyMode;
  displayJsonCollapsed?: boolean;
};

type ServerConfigDoc = {
  _id: string;
  serverName: string;
  password?: string;
  displayBodyMode?: DisplayBodyMode;
  displayJsonCollapsed?: boolean;
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

export async function getServerDisplaySettings(
  serverName: string,
): Promise<ServerDisplaySettings> {
  const normalized = normalizeServerName(serverName);
  if (!normalized) return { ...DEFAULT_DISPLAY_SETTINGS };

  const collection = await serverConfigsCollection();
  const existing = await collection.findOne({ _id: normalized });
  return {
    displayBodyMode:
      existing?.displayBodyMode === "bulk" || existing?.displayBodyMode === "table"
        ? existing.displayBodyMode
        : DEFAULT_DISPLAY_SETTINGS.displayBodyMode,
    displayJsonCollapsed:
      typeof existing?.displayJsonCollapsed === "boolean"
        ? existing.displayJsonCollapsed
        : DEFAULT_DISPLAY_SETTINGS.displayJsonCollapsed,
  };
}

export async function setServerDisplaySettings(
  serverName: string,
  patch: Partial<ServerDisplaySettings>,
): Promise<{ ok: boolean; message?: string; settings?: ServerDisplaySettings }> {
  const normalized = normalizeServerName(serverName);
  if (!normalized) {
    return { ok: false, message: "server_name é obrigatório." };
  }

  const collection = await serverConfigsCollection();
  const existing = await collection.findOne({ _id: normalized });
  if (!existing) {
    return { ok: false, message: "Servidor não encontrado." };
  }

  const next: Partial<ServerConfigDoc> = {};
  if (patch.displayBodyMode === "table" || patch.displayBodyMode === "bulk") {
    next.displayBodyMode = patch.displayBodyMode;
  }
  if (typeof patch.displayJsonCollapsed === "boolean") {
    next.displayJsonCollapsed = patch.displayJsonCollapsed;
  }

  if (Object.keys(next).length > 0) {
    await collection.updateOne({ _id: normalized }, { $set: next });
  }

  const settings = await getServerDisplaySettings(normalized);
  return { ok: true, settings };
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
