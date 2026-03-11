import { NextResponse } from "next/server";
import { getRouteStats, setRouteConfig } from "@/lib/server/request-log";

export async function GET() {
  const routes = getRouteStats();
  return NextResponse.json(routes);
}

export async function POST(request: Request) {
  const body = await request.json();
  const { method, path, status, headers, responseBody } = body as {
    method: string;
    path: string;
    status?: number;
    headers?: Record<string, string>;
    responseBody?: unknown;
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
  });

  return NextResponse.json(config);
}


