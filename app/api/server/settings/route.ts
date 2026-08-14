import { NextResponse } from "next/server";
import {
  deleteServerAndAllData,
  getServerDisplaySettings,
  serverRequiresPassword,
  setServerDisplaySettings,
  setServerPassword,
  type DisplayBodyMode,
} from "@/lib/server/server-config";
import {
  getServerFromCookie,
  SERVER_COOKIE_NAME,
} from "@/lib/server/server-session";
import { clientManager } from "@/lib/server/websocket";

function clearServerCookie(response: NextResponse) {
  response.cookies.set({
    name: SERVER_COOKIE_NAME,
    value: "",
    path: "/",
    maxAge: 0,
  });
}

export async function GET(request: Request) {
  const serverName = getServerFromCookie(request);
  if (!serverName) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  const [hasPassword, display] = await Promise.all([
    serverRequiresPassword(serverName),
    getServerDisplaySettings(serverName),
  ]);
  return NextResponse.json({
    serverName,
    hasPassword,
    ...display,
  });
}

export async function PATCH(request: Request) {
  const serverName = getServerFromCookie(request);
  if (!serverName) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body inválido." }, { status: 400 });
  }

  const hasDisplayPatch =
    body.displayBodyMode !== undefined ||
    body.displayJsonCollapsed !== undefined;
  const hasPasswordPatch =
    typeof body.password === "string" ||
    typeof body.currentPassword === "string";

  if (hasDisplayPatch && !hasPasswordPatch) {
    const patch: {
      displayBodyMode?: DisplayBodyMode;
      displayJsonCollapsed?: boolean;
    } = {};
    if (body.displayBodyMode === "table" || body.displayBodyMode === "bulk") {
      patch.displayBodyMode = body.displayBodyMode;
    } else if (body.displayBodyMode !== undefined) {
      return NextResponse.json(
        { error: "displayBodyMode inválido." },
        { status: 400 },
      );
    }
    if (typeof body.displayJsonCollapsed === "boolean") {
      patch.displayJsonCollapsed = body.displayJsonCollapsed;
    } else if (body.displayJsonCollapsed !== undefined) {
      return NextResponse.json(
        { error: "displayJsonCollapsed inválido." },
        { status: 400 },
      );
    }

    const result = await setServerDisplaySettings(serverName, patch);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.message ?? "Falha ao atualizar configurações." },
        { status: 400 },
      );
    }
    return NextResponse.json({ ok: true, ...result.settings });
  }

  const password = typeof body?.password === "string" ? body.password : "";
  const currentPassword =
    typeof body?.currentPassword === "string" ? body.currentPassword : undefined;

  const result = await setServerPassword(serverName, password, currentPassword);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.message ?? "Falha ao atualizar senha." },
      { status: 400 },
    );
  }

  return NextResponse.json({
    ok: true,
    hasPassword: result.hasPassword ?? false,
  });
}

export async function DELETE(request: Request) {
  const serverName = getServerFromCookie(request);
  if (!serverName) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const confirmName =
    typeof body?.confirmName === "string" ? body.confirmName.trim().toLowerCase() : "";

  if (!confirmName || confirmName !== serverName.trim().toLowerCase()) {
    return NextResponse.json(
      { error: "Digite o nome do servidor para confirmar a exclusão." },
      { status: 400 },
    );
  }

  try {
    clientManager.disconnectAllForServer(serverName);
  } catch {
    // WS pode não estar disponível no mesmo processo; segue com o delete.
  }

  await deleteServerAndAllData(serverName);

  const response = NextResponse.json({ ok: true });
  clearServerCookie(response);
  return response;
}
