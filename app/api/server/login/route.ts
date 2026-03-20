import { NextResponse } from "next/server";
import { verifyOrCreateServerConfig } from "@/lib/server/server-config";
import { SERVER_COOKIE_NAME } from "@/lib/server/server-session";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const serverName = (body?.serverName as string | undefined)?.trim() ?? "";
  const password = (body?.password as string | undefined) ?? "";

  const result = await verifyOrCreateServerConfig(serverName, password);
  if (!result.ok || !result.serverName) {
    return NextResponse.json(
      { error: result.message ?? "Falha ao autenticar servidor." },
      { status: 401 },
    );
  }

  const response = NextResponse.json({
    ok: true,
    serverName: result.serverName,
  });
  response.cookies.set({
    name: SERVER_COOKIE_NAME,
    value: result.serverName,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return response;
}
