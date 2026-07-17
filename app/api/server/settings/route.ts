import { NextResponse } from "next/server";
import {
  deleteServerAndAllData,
  serverRequiresPassword,
  setServerPassword,
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

  const hasPassword = await serverRequiresPassword(serverName);
  return NextResponse.json({ serverName, hasPassword });
}

export async function PATCH(request: Request) {
  const serverName = getServerFromCookie(request);
  if (!serverName) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
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
