import { NextResponse } from "next/server";
import {
  getRouteStatsWithConfigs,
  setRouteConfig,
  deleteRouteConfig,
} from "@/lib/server/request-log";
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
  const routes = await getRouteStatsWithConfigs(serverName);
  return NextResponse.json(routes);
}

export async function POST(request: Request) {
  const serverName = getServerFromCookie(request);
  if (!serverName) return unauthorized();
  const body = await request.json();
  const { method, path, status, headers, responseBody, proxyMode, proxyUrl } = body as {
    method: string;
    path: string;
    status?: number;
    headers?: Record<string, string>;
    responseBody?: unknown;
    proxyMode?: boolean;
    proxyUrl?: string;
  };

  if (!method || !path) {
    return NextResponse.json(
      { error: "method e path são obrigatórios" },
      { status: 400 },
    );
  }

  const config = await setRouteConfig(serverName, {
    method,
    path,
    status: status ?? 200,
    headers: headers ?? {},
    body: responseBody ?? null,
    proxyMode: Boolean(proxyMode),
    proxyUrl: proxyUrl?.trim() ?? "",
  });

  return NextResponse.json(config);
}

export async function DELETE(request: Request) {
  const serverName = getServerFromCookie(request);
  if (!serverName) return unauthorized();
  const body = await request.json().catch(() => null);
  const method = body?.method as string | undefined;
  const path = body?.path as string | undefined;

  if (!method || !path) {
    return NextResponse.json(
      { error: "method e path são obrigatórios" },
      { status: 400 },
    );
  }

  const removed = await deleteRouteConfig(serverName, method, path);
  return NextResponse.json({ ok: removed });
}

