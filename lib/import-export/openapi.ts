import type { RouteConfigInput } from "./types";

const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
] as const;

type HttpMethod = (typeof HTTP_METHODS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** OpenAPI `{id}` → Freeceptor `:id` */
export function openApiPathToFreeceptor(path: string): string {
  return path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const cleaned = String(name).replace(/[^a-zA-Z0-9_]/g, "_") || "param";
    return `:${cleaned}`;
  });
}

/** Freeceptor `:id` / legacy `*` → OpenAPI `{id}` / `{paramN}` */
export function freeceptorPathToOpenApi(path: string): string {
  let paramIndex = 0;
  return path
    .split("/")
    .map((seg) => {
      if (seg === "*") {
        paramIndex += 1;
        return `{param${paramIndex}}`;
      }
      if (seg.startsWith(":") && seg.length > 1) {
        return `{${seg.slice(1)}}`;
      }
      return seg;
    })
    .join("/");
}

function pickResponse(
  responses: Record<string, unknown>,
): { status: number; response: Record<string, unknown> } | null {
  const entries = Object.entries(responses)
    .map(([code, response]) => ({
      code,
      status: Number(code),
      response: isRecord(response) ? response : null,
    }))
    .filter(
      (e) =>
        e.response !== null &&
        !Number.isNaN(e.status) &&
        e.status >= 200 &&
        e.status < 300,
    )
    .sort((a, b) => a.status - b.status);

  if (entries.length > 0) {
    return { status: entries[0].status, response: entries[0].response! };
  }

  const defaultEntry = responses.default;
  if (isRecord(defaultEntry)) {
    return { status: 200, response: defaultEntry };
  }

  const first = Object.entries(responses).find(([, v]) => isRecord(v));
  if (first && isRecord(first[1])) {
    const status = Number(first[0]);
    return {
      status: Number.isNaN(status) ? 200 : status,
      response: first[1],
    };
  }

  return null;
}

function extractBodyAndContentType(
  response: Record<string, unknown>,
  isSwagger2: boolean,
): { body: unknown; contentType: string } {
  if (isSwagger2) {
    const schema = response.schema;
    if (isRecord(schema) && "example" in schema) {
      return { body: schema.example, contentType: "application/json" };
    }
    if (response.examples && isRecord(response.examples)) {
      const first = Object.values(response.examples)[0];
      if (isRecord(first) && "value" in first) {
        return { body: first.value, contentType: "application/json" };
      }
    }
    return { body: null, contentType: "application/json" };
  }

  const content = response.content;
  if (!isRecord(content)) {
    return { body: null, contentType: "application/json" };
  }

  const mediaTypes = Object.keys(content);
  const mediaType = mediaTypes[0] ?? "application/json";
  const media = content[mediaType];
  if (!isRecord(media)) {
    return { body: null, contentType: mediaType };
  }

  if ("example" in media) {
    return { body: media.example, contentType: mediaType };
  }
  if (isRecord(media.schema) && "example" in media.schema) {
    return { body: media.schema.example, contentType: mediaType };
  }

  return { body: null, contentType: mediaType };
}

export function openApiToRouteConfigs(
  doc: unknown,
  apiName: string,
): RouteConfigInput[] {
  if (!isRecord(doc) || !isRecord(doc.paths)) {
    throw new Error("Documento OpenAPI inválido: campo paths ausente.");
  }

  const isSwagger2 = typeof doc.swagger === "string";
  const configs: RouteConfigInput[] = [];

  for (const [rawPath, pathItem] of Object.entries(doc.paths)) {
    if (!isRecord(pathItem)) continue;
    const freeceptorPath = openApiPathToFreeceptor(rawPath);

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!isRecord(operation)) continue;

      const responses = operation.responses;
      let status = 200;
      let body: unknown = null;
      let headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (isRecord(responses)) {
        const picked = pickResponse(responses);
        if (picked) {
          status = picked.status;
          const extracted = extractBodyAndContentType(
            picked.response,
            isSwagger2,
          );
          body = extracted.body;
          headers = { "Content-Type": extracted.contentType };
        }
      }

      configs.push({
        apiName,
        method: method.toUpperCase(),
        path: freeceptorPath,
        status,
        body,
        headers,
        proxyMode: false,
        proxyUrl: "",
        proxyToClient: false,
        proxyClientId: "",
        proxyServiceName: "",
      });
    }
  }

  if (configs.length === 0) {
    throw new Error("Nenhuma operação HTTP encontrada no documento OpenAPI.");
  }

  return configs;
}

export function routeConfigsToOpenApi(
  configs: RouteConfigInput[],
  apiName: string,
): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const cfg of configs) {
    const openApiPath = freeceptorPathToOpenApi(cfg.path);
    const method = cfg.method.toLowerCase() as HttpMethod;
    if (!HTTP_METHODS.includes(method)) continue;

    const contentType =
      cfg.headers["Content-Type"] ??
      cfg.headers["content-type"] ??
      "application/json";

    const statusKey = String(cfg.status || 200);

    if (!paths[openApiPath]) {
      paths[openApiPath] = {};
    }

    paths[openApiPath][method] = {
      summary: `${cfg.method} ${cfg.path}`,
      responses: {
        [statusKey]: {
          description: "Mock response",
          content: {
            [contentType]: {
              example: cfg.body ?? null,
            },
          },
        },
      },
    };
  }

  return {
    openapi: "3.0.3",
    info: {
      title: apiName,
      version: "1.0.0",
    },
    paths,
  };
}
