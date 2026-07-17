import { NextResponse } from "next/server";
import {
  getAllApiConfigs,
  setApiConfig,
  setApiOrder,
  deleteApiAndAllData,
  type ApiConfig,
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
  const apis = await getAllApiConfigs(serverName);
  return NextResponse.json(apis);
}

export async function POST(request: Request) {
  const serverName = getServerFromCookie(request);
  if (!serverName) return unauthorized();

  const body = await request.json().catch(() => null);
  const {
    apiName,
    proxyMode,
    proxyUrl,
    proxyToClient,
    proxyClientId,
    proxyServiceName,
  } = (body ?? {}) as {
    apiName?: string;
    proxyMode?: boolean;
    proxyUrl?: string;
    proxyToClient?: boolean;
    proxyClientId?: string;
    proxyServiceName?: string;
  };

  if (!apiName) {
    return NextResponse.json(
      { error: "apiName é obrigatório." },
      { status: 400 },
    );
  }

  const config: ApiConfig = {
    apiName,
    proxyMode: Boolean(proxyMode),
    proxyUrl: proxyUrl?.trim() ?? "",
    proxyToClient: Boolean(proxyToClient),
    proxyClientId: proxyClientId?.trim() ?? "",
    proxyServiceName: proxyServiceName?.trim() ?? "",
  };

  const saved = await setApiConfig(serverName, config);
  return NextResponse.json(saved);
}

export async function PUT(request: Request) {
  const serverName = getServerFromCookie(request);
  if (!serverName) return unauthorized();

  const body = await request.json().catch(() => null);
  const { order } = (body ?? {}) as { order?: string[] };

  if (!Array.isArray(order) || order.some((name) => typeof name !== "string")) {
    return NextResponse.json(
      { error: "order deve ser um array de apiNames." },
      { status: 400 },
    );
  }

  const apis = await setApiOrder(serverName, order);
  return NextResponse.json(apis);
}

export async function DELETE(request: Request) {
  const serverName = getServerFromCookie(request);
  if (!serverName) return unauthorized();

  const { searchParams } = new URL(request.url);
  const apiName = searchParams.get("apiName") ?? undefined;

  if (!apiName) {
    return NextResponse.json(
      { error: "apiName é obrigatório." },
      { status: 400 },
    );
  }

  await deleteApiAndAllData(serverName, apiName);
  return NextResponse.json({ ok: true });
}
