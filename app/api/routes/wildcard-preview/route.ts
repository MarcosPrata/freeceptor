import { NextResponse } from "next/server";
import { getRoutesAffectedByWildcard } from "@/lib/server/request-log";
import { getServerFromCookie } from "@/lib/server/server-session";

function unauthorized() {
  return NextResponse.json(
    { error: "server não autenticado." },
    { status: 401 },
  );
}

export async function GET(request: Request) {
  const serverName = getServerFromCookie(request);
  if (!serverName) return unauthorized();

  const url = new URL(request.url);
  const apiName = url.searchParams.get("apiName") || "default";
  const method = url.searchParams.get("method");
  const path = url.searchParams.get("path");
  const excludePath = url.searchParams.get("excludePath") ?? undefined;

  if (!method || !path) {
    return NextResponse.json(
      { error: "method e path são obrigatórios" },
      { status: 400 },
    );
  }

  const affected = await getRoutesAffectedByWildcard(
    serverName,
    apiName,
    method,
    path,
    excludePath,
  );

  return NextResponse.json(affected);
}
