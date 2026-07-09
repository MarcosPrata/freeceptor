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

function getApiName(request: Request): string {
  const url = new URL(request.url);
  return url.searchParams.get("apiName") || "default";
}

export async function GET(request: Request) {
  const serverName = getServerFromCookie(request);
  if (!serverName) return unauthorized();
  const apiName = getApiName(request);
  const routes = await getRouteStatsWithConfigs(serverName, apiName);
  return NextResponse.json(routes);
}

export async function POST(request: Request) {
  const serverName = getServerFromCookie(request);
  if (!serverName) return unauthorized();
  const body = await request.json();
  const {
    apiName,
    method,
    path,
    status,
    headers,
    responseBody,
    proxyMode,
    proxyUrl,
    proxyToClient,
    proxyClientId,
    proxyServiceName,
  } = body as {
    apiName?: string;
    method: string;
    path: string;
    status?: number;
    headers?: Record<string, string>;
    responseBody?: unknown;
    proxyMode?: boolean;
    proxyUrl?: string;
    proxyToClient?: boolean;
    proxyClientId?: string;
    proxyServiceName?: string;
  };

  if (!method || !path) {
    return NextResponse.json(
      { error: "method e path são obrigatórios" },
      { status: 400 },
    );
  }

  const config = await setRouteConfig(serverName, {
    apiName: apiName ?? "default",
    method,
    path,
    status: status ?? 200,
    headers: headers ?? {},
    body: responseBody ?? null,
    proxyMode: Boolean(proxyMode),
    proxyUrl: proxyUrl?.trim() ?? "",
    proxyToClient: Boolean(proxyToClient),
    proxyClientId: proxyClientId?.trim() ?? "",
    proxyServiceName: proxyServiceName?.trim() ?? "",
  });

  return NextResponse.json(config);
}

export async function DELETE(request: Request) {
  const serverName = getServerFromCookie(request);
  if (!serverName) return unauthorized();
  const body = await request.json().catch(() => null);
  const apiName = (body?.apiName as string | undefined) ?? "default";
  const method = body?.method as string | undefined;
  const path = body?.path as string | undefined;

  if (!method || !path) {
    return NextResponse.json(
      { error: "method e path são obrigatórios" },
      { status: 400 },
    );
  }

  const removed = await deleteRouteConfig(serverName, apiName, method, path);
  return NextResponse.json({ ok: removed });
}
