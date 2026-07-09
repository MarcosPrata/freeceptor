import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import type { ProxyConfig } from "./config.js";

type RequestBody = string | Buffer | null;

async function readRequestBody(req: http.IncomingMessage): Promise<RequestBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(null);
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    req.on("error", reject);
  });
}

function parseJsonSafe(data: RequestBody): unknown {
  if (!data) return null;
  try {
    return JSON.parse(data.toString("utf-8"));
  } catch {
    return data.toString("utf-8");
  }
}

function headersToRecord(headers: http.IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      result[key] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return result;
}

async function forwardToTarget(
  config: ProxyConfig,
  req: http.IncomingMessage,
  body: RequestBody,
): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
  const targetUrl = new URL(req.url ?? "/", config.targetUrl);
  const protocol = targetUrl.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const proxyReq = protocol.request(
      targetUrl,
      {
        method: req.method,
        headers: {
          ...req.headers,
          host: targetUrl.host,
        },
      },
      (proxyRes) => {
        const chunks: Buffer[] = [];
        proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
        proxyRes.on("end", () => {
          const responseBody = Buffer.concat(chunks);
          resolve({
            status: proxyRes.statusCode ?? 500,
            headers: headersToRecord(proxyRes.headers),
            body: parseJsonSafe(responseBody),
          });
        });
        proxyRes.on("error", reject);
      },
    );

    proxyReq.on("error", reject);

    if (body) {
      proxyReq.write(body);
    }
    proxyReq.end();
  });
}

async function logToFreeceptor(
  config: ProxyConfig,
  req: http.IncomingMessage,
  requestBody: RequestBody,
  response: { status: number; headers: Record<string, string>; body: unknown },
): Promise<void> {
  const freeceptorUrl = new URL(
    `/api/${config.serverName}${req.url ?? "/"}`,
    config.freeceptorUrl,
  );

  const logPayload = {
    originalRequest: {
      method: req.method,
      url: req.url,
      headers: headersToRecord(req.headers),
      body: parseJsonSafe(requestBody),
    },
    proxyResponse: {
      status: response.status,
      headers: response.headers,
      body: response.body,
    },
    targetUrl: config.targetUrl,
    timestamp: new Date().toISOString(),
  };

  const protocol = freeceptorUrl.protocol === "https:" ? https : http;

  return new Promise((resolve) => {
    const logReq = protocol.request(
      freeceptorUrl,
      {
        method: req.method ?? "GET",
        headers: {
          "Content-Type": "application/json",
          "X-Freeceptor-Proxy": "true",
          "X-Freeceptor-Target": config.targetUrl,
          "X-Freeceptor-Response-Status": String(response.status),
          ...(config.serverPassword && { "X-Freeceptor-Password": config.serverPassword }),
        },
      },
      () => resolve(),
    );

    logReq.on("error", (err) => {
      if (config.verbose) {
        console.error("[Freeceptor] Failed to log request:", err.message);
      }
      resolve();
    });

    logReq.write(JSON.stringify(requestBody ? parseJsonSafe(requestBody) : null));
    logReq.end();
  });
}

export function createProxyServer(config: ProxyConfig): http.Server {
  const server = http.createServer(async (req, res) => {
    const startTime = Date.now();

    if (config.verbose) {
      console.log(`[Proxy] ${req.method} ${req.url}`);
    }

    try {
      const requestBody = await readRequestBody(req);
      const targetResponse = await forwardToTarget(config, req, requestBody);

      logToFreeceptor(config, req, requestBody, targetResponse).catch(() => {});

      res.writeHead(targetResponse.status, targetResponse.headers);

      if (targetResponse.body !== null && targetResponse.body !== undefined) {
        const bodyStr =
          typeof targetResponse.body === "string"
            ? targetResponse.body
            : JSON.stringify(targetResponse.body);
        res.end(bodyStr);
      } else {
        res.end();
      }

      if (config.verbose) {
        const duration = Date.now() - startTime;
        console.log(
          `[Proxy] ${req.method} ${req.url} -> ${targetResponse.status} (${duration}ms)`,
        );
      }
    } catch (err) {
      console.error("[Proxy] Error:", err);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Bad Gateway",
          message: err instanceof Error ? err.message : "Unknown error",
        }),
      );
    }
  });

  return server;
}
