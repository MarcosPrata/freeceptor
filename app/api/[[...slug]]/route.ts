import { NextResponse } from "next/server";
import {
  addRequestLog,
  getRouteConfigFor,
  resolveProxyConfig,
  setRouteConfig,
  migrateExistingRecords,
} from "@/lib/server/request-log";
import {
  buildDynamicMockContext,
  resolveDynamicMock,
} from "@/lib/server/dynamic-mock";
import { ensureServerConfigExists } from "@/lib/server/server-config";
import { getMergedClientsByServer } from "@/lib/server/proxy-clients";
import { clientManager } from "@/lib/server/websocket";
import type { RequestMessage } from "@/lib/server/websocket";
import { looksLikeSseRequest } from "@/lib/server/looks-like-sse";
import { bindLiveStream, tapReadableStream } from "@/lib/server/live-streams";
import { abortMockSseStream, createMockSseStream, parseFakeSseQuery } from "@/lib/server/mock-sse";
import { onRequestClosed } from "@/lib/server/request-lifetime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
    } else if (isBinaryContentType(contentType)) {
      // Avoid decoding binary as UTF-8 (corrupts bytes in the request log).
      body = {
        _type: "binary",
        size: rawRequestBody.byteLength,
        mimeType: contentType.split(";")[0]?.trim() || "application/octet-stream",
      };
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
  let proxyClientOffline = false;
  let sseBody: ReadableStream<Uint8Array> | null = null;
  let sseStreamId: string | undefined;

  const forwardedPath = extractAppendedPath(
    url.pathname,
    serverNameFromPath,
    apiNameFromPath,
  );
  const wantsSse = looksLikeSseRequest(method, forwardedPath, headers);

  const hasActiveProxy =
    (resolved.proxyToClient &&
      resolved.proxyClientId &&
      resolved.proxyServiceName) ||
    (resolved.proxyMode && resolved.proxyUrl);

  if (!hasActiveProxy) {
    const routeConfig = await getRouteConfigFor(
      serverName,
      apiNameFromPath,
      method,
      pathFromSlug,
    );
    if (routeConfig?.explicitlyConfigured) {
      const rawBodyText =
        typeof body === "string"
          ? body
          : body == null
            ? ""
            : undefined;
      const dynamic = resolveDynamicMock(
        routeConfig,
        buildDynamicMockContext({
          headers,
          queryParams,
          body,
          rawBodyText,
          requestPath: pathFromSlug,
          patternPath: routeConfig.path,
        }),
      );
      responseStatus = dynamic.status;
      responseHeaders = dynamic.headers;
      responseBody = dynamic.body;
    }
  }

  if (resolved.proxyToClient && resolved.proxyClientId && resolved.proxyServiceName) {
    try {
      if (wantsSse) {
        const proxied = await proxyToClientStream({
          incomingRequest: request,
          serverName,
          clientId: resolved.proxyClientId,
          serviceName: resolved.proxyServiceName,
          method,
          path: forwardedPath,
          headers,
          rawRequestBody,
          queryParams,
        });
        responseStatus = proxied.status;
        responseHeaders = proxied.headers;
        responseBody = { _type: "sse-stream", live: true };
        sseBody = proxied.body;
        sseStreamId = proxied.requestId;
        proxyClientId = resolved.proxyClientId;
        proxyClientName = proxied.clientName;
        proxyServiceName = resolved.proxyServiceName;
      } else {
        const proxied = await proxyToClientRequest({
          serverName,
          clientId: resolved.proxyClientId,
          serviceName: resolved.proxyServiceName,
          method,
          path: forwardedPath,
          headers,
          rawRequestBody,
          queryParams,
        });

        responseStatus = proxied.status;
        responseHeaders = proxied.headers;
        responseBody = proxied.body;
        proxyClientId = resolved.proxyClientId;
        proxyClientName = proxied.clientName;
        proxyServiceName = resolved.proxyServiceName;
      }
    } catch (error) {
      responseStatus = 502;
      responseHeaders = {};
      responseBody = {
        error: "Falha ao encaminhar para cliente conectado.",
        details: error instanceof Error ? error.message : String(error),
      };
      proxyClientId = resolved.proxyClientId;
      proxyServiceName = resolved.proxyServiceName;
      proxyClientOffline = true;
    }
  } else if (resolved.proxyMode && resolved.proxyUrl) {
    try {
      if (wantsSse) {
        const proxied = await proxyRequestStreaming({
          originalRequest: request,
          targetUrl: resolved.proxyUrl,
          incomingUrl: url,
          serverName: serverNameFromPath,
          apiName: apiNameFromPath,
          rawRequestBody,
        });
        responseStatus = proxied.status;
        responseHeaders = proxied.headers;
        responseBody = { _type: "sse-stream", live: true };
        sseBody = proxied.body;
        sseStreamId = proxied.streamId;
        proxyResolvedUrl = proxied.resolvedUrl;
      } else {
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
      }
    } catch (error) {
      responseStatus = 502;
      responseHeaders = {};
      responseBody = {
        error: "Falha ao encaminhar para URL do proxy.",
        details: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const mockFake = parseFakeSseQuery(queryParams);
  let mockSse = false;

  if (wantsSse && !sseBody && !hasActiveProxy) {
    sseStreamId = generateRequestId();
    sseBody = createMockSseStream(sseStreamId, {
      fakeEnabled: mockFake.enabled,
      fakeIntervalMs: mockFake.intervalMs,
      serverName,
      apiName: apiNameFromPath,
      method,
      path: pathFromSlug,
    });
    mockSse = true;
    responseStatus = 200;
    responseHeaders = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
    };
    responseBody = { _type: "sse-stream", live: true, mock: true };
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

  const logId = await addRequestLog(serverName, apiNameFromPath, {
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
    configSource: resolved.source,
    overrodeApiProxy: resolved.overrodeApiProxy,
    proxyClientOffline,
    body,
    headers,
    responseStatus,
    responseBody,
    responseHeaders,
  });

  if (sseStreamId && sseBody) {
    bindLiveStream(sseStreamId, {
      logId,
      serverName,
      apiName: apiNameFromPath,
      method,
      path: pathFromSlug,
      status: responseStatus,
      mock: mockSse,
      source: mockSse
        ? "mock"
        : proxyClientId
          ? "client"
          : resolved.proxyMode && resolved.proxyUrl
            ? "url"
            : "mock",
      overrodeApiProxy: Boolean(resolved.overrodeApiProxy),
      fakeEventsEnabled: mockSse ? mockFake.enabled : false,
      fakeEventsIntervalMs: mockSse ? mockFake.intervalMs : undefined,
    });
    const streamId = sseStreamId;
    const isMockStream = mockSse;
    onRequestClosed(() => {
      if (isMockStream) abortMockSseStream(streamId);
      else clientManager.abortStream(streamId);
    }, request);
  }

  if (sseBody) {
    return buildStreamResponse(responseStatus, responseHeaders, sseBody);
  }

  return buildOutboundResponse(
    responseStatus,
    responseHeaders,
    responseBody,
    proxyRawResponseBody,
  );
}

/**
 * Builds the HTTP response for the caller.
 * Proxy-to-client bodies arrive as parsed JSON objects or raw strings (e.g. HTML).
 * Using NextResponse.json on a string would double-encode it ("\\n..."), which
 * breaks Swagger UI and other non-JSON responses.
 *
 * Statuses 204/205/304 must not carry a body (Fetch Response constructor throws).
 */
function buildOutboundResponse(
  status: number,
  headers: Record<string, string>,
  body: unknown,
  rawBody?: ArrayBuffer | null,
): NextResponse {
  const outboundHeaders = sanitizeProxyResponseHeaders(headers);

  if (isNullBodyStatus(status)) {
    return new NextResponse(null, {
      status,
      headers: outboundHeaders,
    });
  }

  if (rawBody) {
    return new NextResponse(rawBody, {
      status,
      headers: outboundHeaders,
    });
  }

  if (typeof body === "string") {
    return new NextResponse(body, {
      status,
      headers: outboundHeaders,
    });
  }

  if (body === null || body === undefined) {
    return new NextResponse(null, {
      status,
      headers: outboundHeaders,
    });
  }

  return NextResponse.json(body, {
    status,
    headers: outboundHeaders,
  });
}

function isNullBodyStatus(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

function buildStreamResponse(
  status: number,
  headers: Record<string, string>,
  body: ReadableStream<Uint8Array>,
): NextResponse {
  const outboundHeaders = sanitizeProxyResponseHeaders(headers);
  outboundHeaders["Cache-Control"] = "no-cache, no-transform";
  outboundHeaders["X-Accel-Buffering"] = "no";
  const hasContentType = Object.keys(outboundHeaders).some(
    (key) => key.toLowerCase() === "content-type",
  );
  if (!hasContentType) {
    outboundHeaders["Content-Type"] = "text/event-stream";
  }
  return new NextResponse(body, {
    status,
    headers: outboundHeaders,
  });
}

function sanitizeProxyResponseHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const hopByHop = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    // Body may be re-encoded after WebSocket transport; let the runtime set length.
    "content-length",
    // Original Host points at Freeceptor, not the local service / caller.
    "host",
    "x-freeceptor-lifetime",
  ]);

  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (!hopByHop.has(key.toLowerCase())) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

async function proxyToClientStream({
  incomingRequest,
  serverName,
  clientId,
  serviceName,
  method,
  path,
  headers,
  rawRequestBody,
  queryParams,
}: {
  incomingRequest: Request;
  serverName: string;
  clientId: string;
  serviceName: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  rawRequestBody: ArrayBuffer;
  queryParams: Record<string, string | string[]>;
}): Promise<{
  status: number;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array>;
  requestId: string;
  clientName?: string;
}> {
  const clients = await getMergedClientsByServer(serverName);
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
  const hasBody = shouldSendBody(method) && rawRequestBody.byteLength > 0;
  const requestId = generateRequestId();
  const requestMessage: RequestMessage = {
    type: "request",
    requestId,
    targetClientId: clientId,
    serviceName,
    method,
    path: fullPath,
    headers: sanitizeProxyResponseHeaders(headers),
    body: hasBody ? Buffer.from(rawRequestBody).toString("base64") : null,
    bodyEncoding: hasBody ? "base64" : undefined,
    stream: true,
  };

  const started = clientManager.registerPendingStream(
    requestId,
    { serverName, clientId },
    30000,
  );

  const sent = clientManager.sendToClient(serverName, clientId, requestMessage);
  if (!sent) {
    clientManager.abortStream(requestId);
    throw new Error(
      `Falha ao enviar requisição para cliente "${client.clientName}".`,
    );
  }

  const onAbort = () => clientManager.abortStream(requestId);
  incomingRequest.signal.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await started;
    return {
      status: response.status,
      headers: response.headers,
      body: response.body,
      requestId,
      clientName: client.clientName,
    };
  } catch (error) {
    incomingRequest.signal.removeEventListener("abort", onAbort);
    throw error;
  }
}

async function proxyToClientRequest({
  serverName,
  clientId,
  serviceName,
  method,
  path,
  headers,
  rawRequestBody,
  queryParams,
}: {
  serverName: string;
  clientId: string;
  serviceName: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  rawRequestBody: ArrayBuffer;
  queryParams: Record<string, string | string[]>;
}): Promise<{
  status: number;
  headers: Record<string, string>;
  body: unknown;
  clientName?: string;
}> {
  const clients = await getMergedClientsByServer(serverName);
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

  // Forward raw bytes (base64 over JSON WS) so multipart / urlencoded / binary
  // survive intact. Agent recalculates Content-Length from the decoded buffer.
  const hasBody =
    shouldSendBody(method) && rawRequestBody.byteLength > 0;
  const requestId = generateRequestId();
  const requestMessage: RequestMessage = {
    type: "request",
    requestId,
    targetClientId: clientId,
    serviceName,
    method,
    path: fullPath,
    // Strip hop-by-hop / host / content-length: body length is recomputed
    // by the agent from the decoded bytes.
    headers: sanitizeProxyResponseHeaders(headers),
    body: hasBody
      ? Buffer.from(rawRequestBody).toString("base64")
      : null,
    bodyEncoding: hasBody ? "base64" : undefined,
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
  proxyHeaders.delete("x-freeceptor-lifetime");

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

async function proxyRequestStreaming({
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
}): Promise<{
  status: number;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array>;
  streamId: string;
  resolvedUrl: string;
}> {
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
  proxyHeaders.delete("x-freeceptor-lifetime");

  const proxiedResponse = await fetch(proxyUrl.toString(), {
    method: originalRequest.method,
    headers: proxyHeaders,
    body: shouldSendBody(originalRequest.method) ? rawRequestBody : undefined,
    redirect: "manual",
    signal: originalRequest.signal,
  });

  if (!proxiedResponse.body) {
    throw new Error("Upstream SSE response has no body.");
  }

  const streamId = generateRequestId();
  return {
    status: proxiedResponse.status,
    headers: Object.fromEntries(proxiedResponse.headers.entries()),
    body: tapReadableStream(proxiedResponse.body, streamId),
    streamId,
    resolvedUrl: proxyUrl.toString(),
  };
}

function shouldSendBody(method: string): boolean {
  return !["GET", "HEAD"].includes(method.toUpperCase());
}

/** Content types whose payload must not be decoded as UTF-8 text for logging. */
function isBinaryContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  if (!ct) return false;
  if (ct.includes("application/octet-stream")) return true;
  if (ct.includes("application/pdf")) return true;
  if (ct.includes("application/zip")) return true;
  if (ct.includes("application/gzip")) return true;
  if (ct.startsWith("image/")) return true;
  if (ct.startsWith("audio/")) return true;
  if (ct.startsWith("video/")) return true;
  if (ct.includes("application/protobuf")) return true;
  if (ct.includes("application/x-protobuf")) return true;
  if (ct.includes("application/grpc")) return true;
  return false;
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
