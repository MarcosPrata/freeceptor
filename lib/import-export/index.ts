export type {
  RouteConfigInput,
  ImportFormat,
  ExportFormat,
  DetectedImport,
} from "./types";

export { parseFileContent, stringifyYaml } from "./parse";

export {
  detectImportFormat,
  getImportFormatLabel,
  countRoutesInImport,
  freeceptorToRouteConfigs,
  countOpenApiOperations,
} from "./detect";

export {
  openApiToRouteConfigs,
  routeConfigsToOpenApi,
  openApiPathToFreeceptor,
  freeceptorPathToOpenApi,
} from "./openapi";

import type { DetectedImport, ImportFormat, RouteConfigInput } from "./types";
import {
  detectImportFormat,
  getImportFormatLabel,
  countRoutesInImport,
  freeceptorToRouteConfigs,
} from "./detect";
import { openApiToRouteConfigs } from "./openapi";

export function analyzeImportFile(
  parsed: unknown,
  apiName: string,
): DetectedImport {
  const format = detectImportFormat(parsed);
  const label = getImportFormatLabel(parsed, format);
  const routeCount = countRoutesInImport(parsed, format, apiName);
  return { format, label, routeCount };
}

export function routeConfigsFromImport(
  parsed: unknown,
  format: ImportFormat,
  apiName: string,
): RouteConfigInput[] {
  if (format === "openapi") {
    return openApiToRouteConfigs(parsed, apiName);
  }
  return freeceptorToRouteConfigs(parsed);
}

export function downloadTextFile(
  content: string,
  fileName: string,
  mimeType: string,
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function exportTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
