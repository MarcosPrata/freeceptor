import { NextResponse } from "next/server";
import { getAllRouteConfigs } from "@/lib/server/request-log";
import { getServerFromCookie } from "@/lib/server/server-session";

export async function GET(request: Request) {
  const serverName = getServerFromCookie(request);
  if (!serverName) {
    return NextResponse.json(
      { error: "server não autenticado." },
      { status: 401 },
    );
  }
  const configs = await getAllRouteConfigs(serverName);
  return NextResponse.json(configs);
}

