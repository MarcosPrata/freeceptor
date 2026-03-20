import { NextResponse } from "next/server";
import { getRequestLogs, clearRequestLogs } from "@/lib/server/request-log";
import { getServerFromCookie } from "@/lib/server/server-session";

export async function GET(request: Request) {
  const serverName = getServerFromCookie(request);
  if (!serverName) {
    return NextResponse.json(
      { error: "server não autenticado." },
      { status: 401 },
    );
  }
  const logs = await getRequestLogs(serverName);
  return NextResponse.json(logs);
}

export async function DELETE(request: Request) {
  const serverName = getServerFromCookie(request);
  if (!serverName) {
    return NextResponse.json(
      { error: "server não autenticado." },
      { status: 401 },
    );
  }
  await clearRequestLogs(serverName);
  return NextResponse.json({ ok: true });
}

