import { NextResponse } from "next/server";
import { addRequestLog } from "@/lib/server/request-log";

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
  const path = url.pathname;
  const method = request.method;
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // body vazio ou não-JSON
  }
  const headers = Object.fromEntries(request.headers);

  addRequestLog({
    method,
    path,
    slug: slug ?? [],
    body,
    headers,
  });

  return NextResponse.json({
    path,
    slug: slug ?? [],
    method,
    body,
    headers,
  });
}
