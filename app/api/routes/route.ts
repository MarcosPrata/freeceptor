import { NextResponse } from "next/server";
import {
  getRouteStatsWithConfigs,
  getAllRouteConfigs,
  setRouteConfig,
  deleteRouteConfig,
} from "@/lib/server/request-log";

export async function GET() {
  const routes = getRouteStatsWithConfigs();
  return NextResponse.json(routes);
}

export async function GETConfigs() {
  const configs = getAllRouteConfigs();
  return NextResponse.json(configs);
}

export async function POST(request: Request) {
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

  const config = setRouteConfig({
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
  const body = await request.json().catch(() => null);
  const method = body?.method as string | undefined;
  const path = body?.path as string | undefined;

  if (!method || !path) {
    return NextResponse.json(
      { error: "method e path são obrigatórios" },
      { status: 400 },
    );
  }

  const removed = deleteRouteConfig(method, path);
  return NextResponse.json({ ok: removed });
}

