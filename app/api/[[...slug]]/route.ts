import { NextResponse } from "next/server";
import {
  addRequestLog,
  getRouteConfigFor,
  setRouteConfig,
} from "@/lib/server/request-log";
import { ensureServerConfigExists } from "@/lib/server/server-config";

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
  if (!slug?.length) {
    return NextResponse.json(
      {
        error:
          "Rota inválida. Use o padrão /api/<nome-do-server>/* para registrar chamadas.",
      },
      { status: 404 },
    );
  }

  const serverNameFromPath = normalizeServerSlug(slug[0]);
  if (!serverNameFromPath) {
    return NextResponse.json(
      { error: "nome-do-server inválido no path." },
      { status: 400 },
    );
  }

  const url = new URL(request.url);
  const method = request.method;
  const serverName = await ensureServerConfigExists(serverNameFromPath);
  const pathFromSlug = slug && slug.length ? `/${slug.join("/")}` : "/";
  const queryParams = toQueryObject(url.searchParams);
  const requestForBodyParsing = request.clone();
  const rawRequestBody = await request
    .arrayBuffer()
    .catch(() => new ArrayBuffer(0));
  let body: unknown = null;
  const contentType = request.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("application/json")) {
      body = await requestForBodyParsing.json();
    } else if (
      contentType.includes("multipart/form-data") ||
      contentType.includes("application/x-www-form-urlencoded")
    ) {
      const formData = await requestForBodyParsing.formData();
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
      const text = await requestForBodyParsing.text();
      body = text || null;
    }
  } catch {
    // body vazio ou não suportado; permanece null
  }
  const headers = Object.fromEntries(request.headers);

  const configured = await getRouteConfigFor(serverName, method, pathFromSlug);
  let responseStatus = configured?.status ?? 200;
  let responseHeaders = configured?.headers ?? {};
  let responseBody = configured?.body ?? ({ status: "ok" } as unknown);

  let proxyRawResponseBody: ArrayBuffer | null = null;

  if (configured?.proxyMode && configured.proxyUrl) {
    try {
      const proxied = await proxyRequest({
        originalRequest: request,
        targetUrl: configured.proxyUrl,
        incomingUrl: url,
        rawRequestBody,
      });

      responseStatus = proxied.status;
      responseHeaders = proxied.headers;
      responseBody = proxied.body;
      proxyRawResponseBody = proxied.rawBody;
    } catch (error) {
      responseStatus = 502;
      responseHeaders = {};
      responseBody = {
        error: "Falha ao encaminhar para URL do proxy.",
        details: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // Garante que toda rota chamada exista também em configs,
  // para continuar aparecendo na aba de rotas mesmo após limpar requests.
  if (!configured) {
    await setRouteConfig(serverName, {
      method,
      path: pathFromSlug,
      status: 200,
      headers: {},
      body: { status: "ok" },
      proxyMode: false,
      proxyUrl: "",
    });
  }

  await addRequestLog(serverName, {
    method,
    path: pathFromSlug,
    slug: slug ?? [],
    queryParams,
    proxyTargetUrl:
      configured?.proxyMode && configured.proxyUrl ? configured.proxyUrl : undefined,
    body,
    headers,
    responseStatus,
    responseBody,
    responseHeaders,
  });

  if (proxyRawResponseBody) {
    return new NextResponse(proxyRawResponseBody, {
      status: responseStatus,
      headers: responseHeaders,
    });
  }

  return NextResponse.json(responseBody, {
    status: responseStatus,
    headers: responseHeaders,
  });
}

async function proxyRequest({
  originalRequest,
  targetUrl,
  incomingUrl,
  rawRequestBody,
}: {
  originalRequest: Request;
  targetUrl: string;
  incomingUrl: URL;
  rawRequestBody: ArrayBuffer;
}) {
  const proxyUrl = new URL(targetUrl);
  for (const [key, value] of incomingUrl.searchParams.entries()) {
    proxyUrl.searchParams.append(key, value);
  }

  const proxyHeaders = new Headers(originalRequest.headers);
  proxyHeaders.delete("host");
  proxyHeaders.delete("content-length");
  proxyHeaders.delete("connection");

  const proxiedResponse = await fetch(proxyUrl.toString(), {
    method: originalRequest.method,
    headers: proxyHeaders,
    body: shouldSendBody(originalRequest.method) ? rawRequestBody : undefined,
    redirect: "manual",
  });

  const proxiedHeaders = Object.fromEntries(proxiedResponse.headers.entries());
  const proxiedBody = await readResponseBody(proxiedResponse.clone());
  const rawBody = await proxiedResponse.arrayBuffer();

  return {
    status: proxiedResponse.status,
    headers: proxiedHeaders,
    body: proxiedBody,
    rawBody,
  };
}

function shouldSendBody(method: string): boolean {
  return !["GET", "HEAD"].includes(method.toUpperCase());
}

async function readResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  const text = await response.text();
  return text || null;
}

function toQueryObject(
  searchParams: URLSearchParams,
): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};

  for (const key of searchParams.keys()) {
    const allValues = searchParams.getAll(key);
    if (allValues.length <= 1) {
      query[key] = allValues[0] ?? "";
      continue;
    }
    query[key] = allValues;
  }

  return query;
}

function normalizeServerSlug(value?: string): string {
  return value?.trim().toLowerCase() ?? "";
}
