import { NextResponse } from "next/server";
import { addRequestLog, getRouteConfigFor } from "@/lib/server/request-log";

type RouteContext = {
  params: Promise<{ slug?: string[] }>;
};

export async function POST(request: Request, context: RouteContext) {
  return readRequest(request, context);
}

export async function GET(request: Request, context: RouteContext) {
  return readRequest(request, context);
}

export async function PUT(request: Request, context: RouteContext) {
  return readRequest(request, context);
}

export async function DELETE(request: Request, context: RouteContext) {
  return readRequest(request, context);
}

export async function PATCH(request: Request, context: RouteContext) {
  return readRequest(request, context);
}

export async function OPTIONS(request: Request, context: RouteContext) {
  return readRequest(request, context);
}

export async function HEAD(request: Request, context: RouteContext) {
  return readRequest(request, context);
}

export async function TRACE(request: Request, context: RouteContext) {
  return readRequest(request, context);
}

export async function CONNECT(request: Request, context: RouteContext) {
  return readRequest(request, context);
}

async function readRequest(request: Request, context: RouteContext) {
  const { slug } = await context.params;
  const url = new URL(request.url);
  const method = request.method;
  const pathFromSlug = slug && slug.length ? `/${slug.join("/")}` : "/";
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // body vazio ou não-JSON
  }
  const headers = Object.fromEntries(request.headers);

  addRequestLog({
    method,
    path: pathFromSlug,
    slug: slug ?? [],
    body,
    headers,
  });

  const configured = getRouteConfigFor(method, pathFromSlug);
  if (configured) {
    return NextResponse.json(configured.body ?? null, {
      status: configured.status,
      headers: configured.headers,
    });
  }

  return NextResponse.json({
    path: pathFromSlug,
    slug: slug ?? [],
    method,
    body,
    headers,
  });
}
