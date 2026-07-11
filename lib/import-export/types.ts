export type RouteConfigInput = {
  apiName: string;
  method: string;
  path: string;
  status: number;
  body: unknown;
  headers: Record<string, string>;
  proxyMode?: boolean;
  proxyUrl?: string;
  proxyToClient?: boolean;
  proxyClientId?: string;
  proxyServiceName?: string;
};

export type ImportFormat = "freeceptor" | "openapi";

export type ExportFormat = "freeceptor" | "openapi-json" | "openapi-yaml";

export type DetectedImport = {
  format: ImportFormat;
  label: string;
  routeCount: number;
};
