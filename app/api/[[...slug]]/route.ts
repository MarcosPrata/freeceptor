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
  console.log("readRequest", request.url);
  const { slug } = await context.params;
  const method = request.method;
  const pathFromSlug = slug && slug.length ? `/${slug.join("/")}` : "/";
  let body: unknown = null;
  const contentType = request.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("application/json")) {
      body = await request.json();
    } else if (
      contentType.includes("multipart/form-data") ||
      contentType.includes("application/x-www-form-urlencoded")
    ) {
      const formData = await request.formData();
      const asObject: Record<string, unknown> = {};

      for (const [key, value] of formData.entries()) {
        if (value instanceof File) {
          asObject[key] = {
            _type: "file",
            name: value.name,
            size: value.size,
            mimeType: value.type,
          };
        } else {
          asObject[key] = value;
        }
      }

      body = {
        _type: "form-data",
        ...asObject,
      };
    } else {
      const text = await request.text();
      body = text || null;
    }
  } catch {
    // body vazio ou não suportado; permanece null
  }
  const headers = Object.fromEntries(request.headers);

  const configured = getRouteConfigFor(method, pathFromSlug);
  const isConfigured = Boolean(configured);
  const responseStatus = configured?.status ?? 200;
  const responseHeaders = configured?.headers ?? {};
  const responseBody =
    configured?.body ??
    ({
      path: pathFromSlug,
      slug: slug ?? [],
      method,
      body,
      headers,
    } as unknown);

  addRequestLog({
    method,
    path: pathFromSlug,
    slug: slug ?? [],
    body,
    headers,
    responseStatus,
    responseBody,
    responseHeaders,
  });

  return NextResponse.json(responseBody, {
    status: responseStatus,
    headers: responseHeaders,
  });
}
