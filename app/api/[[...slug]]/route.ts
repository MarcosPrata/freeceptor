import { NextResponse } from "next/server";
import {
  addRequestLog,
  resolveProxyConfig,
  setRouteConfig,
  migrateExistingRecords,
} from "@/lib/server/request-log";
import { ensureServerConfigExists } from "@/lib/server/server-config";
import { clientManager } from "@/lib/server/websocket";
import type { RequestMessage } from "@/lib/server/websocket";

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

  // Require at least /api/{server}/{api}/{...path}
  if (!slug || slug.length < 2) {
    return NextResponse.json(
      {
        error:
          "Rota inválida. Use o padrão /api/<server>/<api>/* para registrar chamadas.",
      },
      { status: 404 },
    );
  }

  const serverNameFromPath = normalizeSlug(slug[0]);
  const apiNameFromPath = normalizeSlug(slug[1]);

  if (!serverNameFromPath) {
    return NextResponse.json(
      { error: "nome-do-server inválido no path." },
      { status: 400 },
    );
  }
  if (!apiNameFromPath) {
    return NextResponse.json(
      { error: "nome-da-api inválido no path." },
      { status: 400 },
    );
  }

  const url = new URL(request.url);
  const method = request.method;
  const serverName = await ensureServerConfigExists(serverNameFromPath);

  // Run migration for existing records (no-op if already migrated)
  await migrateExistingRecords(serverName);

  // Path is everything after /api/{server}/{api}
  const pathFromSlug = slug.length > 2 ? `/${slug.slice(2).join("/")}` : "/";
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

      body = { _type: "form-data", ...asObject };
    } else {
      const text = await requestForBodyParsing.text();
      body = text || null;
    }
  } catch {
    // body vazio ou não suportado; permanece null
  }

  const headers = Object.fromEntries(request.headers);

  // Resolve proxy with hierarchy: route > api > none
  const resolved = await resolveProxyConfig(
    serverName,
    apiNameFromPath,
    method,
    pathFromSlug,
  );

  let responseStatus = resolved.routeStatus;
  let responseHeaders = resolved.routeHeaders;
  let responseBody = resolved.routeBody;

  let proxyRawResponseBody: ArrayBuffer | null = null;
  let proxyResolvedUrl: string | undefined;
  let proxyClientId: string | undefined;
  let proxyClientName: string | undefined;
  let proxyServiceName: string | undefined;

  if (resolved.proxyToClient && resolved.proxyClientId && resolved.proxyServiceName) {
    try {
      const proxied = await proxyToClientRequest({
        serverName,
        clientId: resolved.proxyClientId,
        serviceName: resolved.proxyServiceName,
        method,
        path: extractAppendedPath(url.pathname, serverNameFromPath, apiNameFromPath),
        headers,
        body,
        queryParams,
      });

      responseStatus = proxied.status;
      responseHeaders = proxied.headers;
      responseBody = proxied.body;
      proxyClientId = resolved.proxyClientId;
      proxyClientName = proxied.clientName;
      proxyServiceName = resolved.proxyServiceName;
    } catch (error) {
      responseStatus = 502;
      responseHeaders = {};
      responseBody = {
        error: "Falha ao encaminhar para cliente conectado.",
        details: error instanceof Error ? error.message : String(error),
      };
      proxyClientId = resolved.proxyClientId;
      proxyServiceName = resolved.proxyServiceName;
    }
  } else if (resolved.proxyMode && resolved.proxyUrl) {
    try {
      const proxied = await proxyRequest({
        originalRequest: request,
        targetUrl: resolved.proxyUrl,
        incomingUrl: url,
        serverName: serverNameFromPath,
        apiName: apiNameFromPath,
        rawRequestBody,
      });

      responseStatus = proxied.status;
      responseHeaders = proxied.headers;
      responseBody = proxied.body;
      proxyRawResponseBody = proxied.rawBody;
      proxyResolvedUrl = proxied.resolvedUrl;
    } catch (error) {
      responseStatus = 502;
      responseHeaders = {};
      responseBody = {
        error: "Falha ao encaminhar para URL do proxy.",
        details: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // Ensure every called route appears in configs (auto-create default config on first call)
  if (resolved.source === "none") {
    await setRouteConfig(serverName, {
      apiName: apiNameFromPath,
      method,
      path: pathFromSlug,
      status: 200,
      headers: {},
      body: { status: "ok" },
      proxyMode: false,
      proxyUrl: "",
      proxyToClient: false,
      proxyClientId: "",
      proxyServiceName: "",
      // Auto-created on first call — not explicitly configured by the user.
      // This allows the API-level proxy to still apply for this route.
      explicitlyConfigured: false,
    });
  }

  await addRequestLog(serverName, apiNameFromPath, {
    method,
    path: pathFromSlug,
    slug: slug ?? [],
    queryParams,
    proxyTargetUrl:
      resolved.proxyMode && resolved.proxyUrl ? resolved.proxyUrl : undefined,
    proxyResolvedUrl,
    proxyClientId,
    proxyClientName,
    proxyServiceName,
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

function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

async function proxyToClientRequest({
  serverName,
  clientId,
  serviceName,
  method,
  path,
  headers,
  body,
  queryParams,
}: {
  serverName: string;
  clientId: string;
  serviceName: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  queryParams: Record<string, string | string[]>;
}): Promise<{
  status: number;
  headers: Record<string, string>;
  body: unknown;
  clientName?: string;
}> {
  const clients = clientManager.getClientsByServer(serverName);
  const client = clients.find((c) => c.clientId === clientId);

  if (!client) {
    throw new Error(`Cliente "${clientId}" não encontrado.`);
  }

  if (client.status !== "online") {
    throw new Error(`Cliente "${client.clientName}" está offline.`);
  }

  const serviceExists = client.localServices.some((s) => s.name === serviceName);
  if (!serviceExists) {
    throw new Error(
      `Serviço "${serviceName}" não disponível no cliente "${client.clientName}".`,
    );
  }

  const queryString = Object.entries(queryParams)
    .map(([key, value]) => {
      if (Array.isArray(value)) {
        return value
          .map((v) => `${encodeURIComponent(key)}=${encodeURIComponent(v)}`)
          .join("&");
      }
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    })
    .join("&");

  const fullPath = queryString ? `${path}?${queryString}` : path;

  const requestId = generateRequestId();
  const requestMessage: RequestMessage = {
    type: "request",
    requestId,
    targetClientId: clientId,
    serviceName,
    method,
    path: fullPath,
    headers,
    body,
  };

  const sent = clientManager.sendToClient(serverName, clientId, requestMessage);
  if (!sent) {
    throw new Error(
      `Falha ao enviar requisição para cliente "${client.clientName}".`,
    );
  }

  const response = await clientManager.registerPendingRequest(requestId, 30000);

  if (response.error) {
    return {
      status: response.status,
      headers: response.headers,
      body: { error: response.error },
      clientName: client.clientName,
    };
  }

  return {
    status: response.status,
    headers: response.headers,
    body: response.body,
    clientName: client.clientName,
  };
}

async function proxyRequest({
  originalRequest,
  targetUrl,
  incomingUrl,
  serverName,
  apiName,
  rawRequestBody,
}: {
  originalRequest: Request;
  targetUrl: string;
  incomingUrl: URL;
  serverName: string;
  apiName: string;
  rawRequestBody: ArrayBuffer;
}) {
  const proxyUrl = new URL(targetUrl);
  const appendedPath = extractAppendedPath(
    incomingUrl.pathname,
    serverName,
    apiName,
  );
  proxyUrl.pathname = joinPaths(proxyUrl.pathname, appendedPath);
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
    resolvedUrl: proxyUrl.toString(),
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

function normalizeSlug(value?: string): string {
  return value?.trim().toLowerCase() ?? "";
}

/**
 * Extracts the path after /api/{server}/{api} from the full pathname.
 * e.g. /api/dev/payments/users/123 → /users/123
 */
function extractAppendedPath(
  pathname: string,
  serverName: string,
  apiName: string,
): string {
  const parts = pathname.split("/").filter(Boolean);
  // parts: ["api", serverName, apiName, ...rest]
  if (parts[0] !== "api") return pathname;
  if (parts[1]?.toLowerCase() !== serverName.toLowerCase()) {
    return `/${parts.slice(1).join("/")}`;
  }
  if (parts[2]?.toLowerCase() !== apiName.toLowerCase()) {
    return `/${parts.slice(2).join("/")}`;
  }
  return `/${parts.slice(3).join("/")}` || "/";
}

function joinPaths(basePath: string, appendedPath: string): string {
  const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  const append = appendedPath.startsWith("/") ? appendedPath : `/${appendedPath}`;
  if (!append || append === "/") return base || "/";
  if (!base || base === "/") return append;
  return `${base}${append}`;
}
