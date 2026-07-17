import { getDb } from "@/lib/server/mongo";

type ClientAuthDoc = {
  _id: string;
  serverName: string;
  clientId: string;
  password?: string;
  updatedAt: string;
};

async function collection() {
  const db = await getDb();
  return db.collection<ClientAuthDoc>("client_auth");
}

function buildId(serverName: string, clientId: string): string {
  return `${serverName}:${clientId}`;
}

export async function setClientAuth(
  serverName: string,
  clientId: string,
  password?: string,
): Promise<void> {
  const col = await collection();
  const id = buildId(serverName, clientId);
  const normalizedPassword = password?.trim() || undefined;
  const updatedAt = new Date().toISOString();

  if (normalizedPassword) {
    await col.updateOne(
      { _id: id },
      {
        $set: {
          _id: id,
          serverName,
          clientId,
          password: normalizedPassword,
          updatedAt,
        },
      },
      { upsert: true },
    );
    return;
  }

  // Remove senha explicitamente (undefined no $set é ignorado pelo driver).
  await col.updateOne(
    { _id: id },
    {
      $set: {
        _id: id,
        serverName,
        clientId,
        updatedAt,
      },
      $unset: { password: "" },
    },
    { upsert: true },
  );
}

export async function clientRequiresEditPassword(
  serverName: string,
  clientId: string,
): Promise<boolean> {
  const col = await collection();
  const doc = await col.findOne({ _id: buildId(serverName, clientId) });
  return Boolean(doc?.password?.trim());
}

export async function getClientEditPasswordRequirements(
  serverName: string,
  clientIds: string[],
): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();
  if (clientIds.length === 0) return map;

  const col = await collection();
  const docs = await col
    .find({
      serverName,
      clientId: { $in: clientIds },
    })
    .toArray();

  for (const clientId of clientIds) {
    map.set(clientId, false);
  }

  for (const doc of docs) {
    map.set(doc.clientId, Boolean(doc.password?.trim()));
  }

  return map;
}

export async function verifyClientEditPassword(
  serverName: string,
  clientId: string,
  password?: string,
): Promise<{ ok: boolean; message?: string }> {
  const col = await collection();
  const doc = await col.findOne({ _id: buildId(serverName, clientId) });

  if (!doc?.password?.trim()) {
    return { ok: true };
  }

  const provided = password?.trim() ?? "";
  if (doc.password.trim() !== provided) {
    return { ok: false, message: "Senha do cliente inválida." };
  }

  return { ok: true };
}
