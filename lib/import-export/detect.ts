import type { ImportFormat, RouteConfigInput } from "./types";
import { openApiToRouteConfigs } from "./openapi";

const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFreeceptorItem(item: unknown): item is RouteConfigInput {
  if (!isRecord(item)) return false;
  return (
    typeof item.method === "string" &&
    typeof item.path === "string" &&
    !("openapi" in item) &&
    !("swagger" in item) &&
    !("paths" in item)
  );
}

function isFreeceptorFormat(parsed: unknown): boolean {
  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (items.length === 0) return false;
  return items.every(isFreeceptorItem);
}

function isOpenApiFormat(parsed: unknown): boolean {
  if (!isRecord(parsed)) return false;
  if (typeof parsed.openapi === "string") return true;
  if (typeof parsed.swagger === "string") return true;
  if (isRecord(parsed.paths) && !Array.isArray(parsed.paths)) {
    return !isFreeceptorFormat(parsed);
  }
  return false;
}

export function detectImportFormat(parsed: unknown): ImportFormat {
  if (isOpenApiFormat(parsed)) return "openapi";
  if (isFreeceptorFormat(parsed)) return "freeceptor";
  throw new Error(
    "Formato não reconhecido. Envie um arquivo Freeceptor ou OpenAPI.",
  );
}

export function getImportFormatLabel(parsed: unknown, format: ImportFormat): string {
  if (format === "freeceptor") return "Freeceptor";
  if (!isRecord(parsed)) return "OpenAPI";
  if (typeof parsed.openapi === "string") {
    const version = parsed.openapi.split(".")[0];
    return `OpenAPI ${version}.x`;
  }
  if (typeof parsed.swagger === "string") {
    return `Swagger ${parsed.swagger}`;
  }
  return "OpenAPI";
}

export function countRoutesInImport(
  parsed: unknown,
  format: ImportFormat,
  apiName: string,
): number {
  if (format === "freeceptor") {
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.filter(isFreeceptorItem).length;
  }
  return openApiToRouteConfigs(parsed, apiName).length;
}

export function freeceptorToRouteConfigs(parsed: unknown): RouteConfigInput[] {
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.map((item) => {
    if (!isFreeceptorItem(item)) {
      throw new Error(
        "JSON inválido: cada item precisa de method e path.",
      );
    }
    return {
      apiName: typeof item.apiName === "string" ? item.apiName : "",
      method: item.method,
      path: item.path,
      status: typeof item.status === "number" ? item.status : 200,
      body: item.body ?? null,
      headers: isRecord(item.headers)
        ? Object.fromEntries(
            Object.entries(item.headers).filter(
              ([, v]) => typeof v === "string",
            ),
          )
        : {},
      proxyMode: Boolean(item.proxyMode),
      proxyUrl: typeof item.proxyUrl === "string" ? item.proxyUrl : "",
      proxyToClient: Boolean(item.proxyToClient),
      proxyClientId:
        typeof item.proxyClientId === "string" ? item.proxyClientId : "",
      proxyServiceName:
        typeof item.proxyServiceName === "string" ? item.proxyServiceName : "",
    };
  });
}

export function countOpenApiOperations(parsed: unknown): number {
  if (!isRecord(parsed) || !isRecord(parsed.paths)) return 0;
  let count = 0;
  for (const pathItem of Object.values(parsed.paths)) {
    if (!isRecord(pathItem)) continue;
    for (const [key, value] of Object.entries(pathItem)) {
      if (HTTP_METHODS.has(key) && isRecord(value)) count++;
    }
  }
  return count;
}
