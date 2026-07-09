import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import type { ProxyConfig } from "./config.js";
import type { ProxyRequestMessage, ProxyResponseMessage } from "./types.js";

export async function executeLocalRequest(
  config: ProxyConfig,
  request: ProxyRequestMessage
): Promise<ProxyResponseMessage> {
  const service = config.localServices.find(
    (s) => s.name === request.serviceName
  );

  if (!service) {
    return {
      type: "response",
      requestId: request.requestId,
      status: 404,
      headers: {},
      body: null,
      error: `Service "${request.serviceName}" not found on this client`,
    };
  }

  try {
    const targetUrl = new URL(
      request.path,
      `http://${service.host}:${service.port}`
    );
    const protocol = targetUrl.protocol === "https:" ? https : http;

    const response = await new Promise<{
      status: number;
      headers: Record<string, string>;
      body: unknown;
    }>((resolve, reject) => {
      const proxyReq = protocol.request(
        targetUrl,
        {
          method: request.method,
          headers: request.headers,
        },
        (proxyRes) => {
          const chunks: Buffer[] = [];
          proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
          proxyRes.on("end", () => {
            const responseBody = Buffer.concat(chunks);
            let parsedBody: unknown;
            
            try {
              parsedBody = JSON.parse(responseBody.toString("utf-8"));
            } catch {
              parsedBody = responseBody.toString("utf-8");
            }

            const headers: Record<string, string> = {};
            for (const [key, value] of Object.entries(proxyRes.headers)) {
              if (value !== undefined) {
                headers[key] = Array.isArray(value) ? value.join(", ") : value;
              }
            }

            resolve({
              status: proxyRes.statusCode ?? 500,
              headers,
              body: parsedBody,
            });
          });
          proxyRes.on("error", reject);
        }
      );

      proxyReq.on("error", reject);

      if (request.body) {
        const bodyStr =
          typeof request.body === "string"
            ? request.body
            : JSON.stringify(request.body);
        proxyReq.write(bodyStr);
      }
      proxyReq.end();
    });

    if (config.verbose) {
      console.log(
        `[Executor] ${request.method} ${request.path} -> ${response.status}`
      );
    }

    return {
      type: "response",
      requestId: request.requestId,
      status: response.status,
      headers: response.headers,
      body: response.body,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    
    if (config.verbose) {
      console.error(`[Executor] Error: ${errorMessage}`);
    }

    return {
      type: "response",
      requestId: request.requestId,
      status: 502,
      headers: {},
      body: null,
      error: errorMessage,
    };
  }
}
