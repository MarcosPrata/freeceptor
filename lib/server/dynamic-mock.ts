import type {
  ApiRouteConfig,
  DynamicMockCondition,
  DynamicMockRule,
  MockJoinOperator,
  MockOperator,
} from "@/lib/server/request-log";
import { extractPathParams } from "@/lib/server/request-log";

export type DynamicMockContext = {
  headers: Record<string, string>;
  queryParams: Record<string, string | string[]>;
  body: unknown;
  rawBodyText?: string;
  pathParams: Record<string, string>;
};

export type DynamicMockResult = {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  matchedRuleId: string | null;
};

function normalizeHeaderMap(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

function readDotPath(value: unknown, path: string): unknown {
  if (!path.trim()) return value;
  const parts = path.split(".").filter(Boolean);
  let current: unknown = value;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function queryValue(
  queryParams: Record<string, string | string[]>,
  key: string,
): string | undefined {
  const raw = queryParams[key];
  if (raw == null) return undefined;
  return Array.isArray(raw) ? raw[0] : raw;
}

export function getComparableValue(
  ctx: DynamicMockContext,
  condition: DynamicMockCondition,
): unknown {
  const key = condition.key?.trim() ?? "";

  switch (condition.source) {
    case "header": {
      if (!key) return undefined;
      return normalizeHeaderMap(ctx.headers)[key.toLowerCase()];
    }
    case "query": {
      if (!key) return undefined;
      return queryValue(ctx.queryParams, key);
    }
    case "path": {
      if (!key) return undefined;
      return ctx.pathParams[key];
    }
    case "body": {
      if (condition.bodyKind === "raw") {
        if (typeof ctx.rawBodyText === "string") return ctx.rawBodyText;
        if (typeof ctx.body === "string") return ctx.body;
        if (ctx.body == null) return undefined;
        try {
          return JSON.stringify(ctx.body);
        } catch {
          return String(ctx.body);
        }
      }
      if (!key) return ctx.body;
      return readDotPath(ctx.body, key);
    }
    default:
      return undefined;
  }
}

function asString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function matchCondition(
  condition: DynamicMockCondition,
  ctx: DynamicMockContext,
): boolean {
  const actual = getComparableValue(ctx, condition);
  const operator: MockOperator = condition.operator;
  const expected = condition.value ?? "";

  switch (operator) {
    case "exists":
      return actual !== undefined && actual !== null && asString(actual) !== "";
    case "notExists":
      return actual === undefined || actual === null || asString(actual) === "";
    case "equals":
      return asString(actual) === expected;
    case "notEquals":
      return asString(actual) !== expected;
    case "contains":
      return asString(actual).includes(expected);
    case "notContains":
      return !asString(actual).includes(expected);
    case "startsWith":
      return asString(actual).startsWith(expected);
    case "endsWith":
      return asString(actual).endsWith(expected);
    default:
      return false;
  }
}

export function matchRule(
  rule: DynamicMockRule,
  ctx: DynamicMockContext,
): boolean {
  const list = rule.conditions ?? [];
  if (list.length === 0) return false;
  let acc = matchCondition(list[0]!, ctx);
  for (let i = 1; i < list.length; i++) {
    const join: MockJoinOperator = rule.joins?.[i - 1] ?? "and";
    const next = matchCondition(list[i]!, ctx);
    acc = join === "or" ? acc || next : acc && next;
  }
  return acc;
}

export function resolveDynamicMock(
  config: ApiRouteConfig,
  ctx: DynamicMockContext,
): DynamicMockResult {
  const rules: DynamicMockRule[] = config.dynamicRules ?? [];
  for (const rule of rules) {
    if (matchRule(rule, ctx)) {
      return {
        status: rule.status || 200,
        body: rule.body ?? { status: "ok" },
        headers: rule.headers ?? {},
        matchedRuleId: rule.id,
      };
    }
  }

  return {
    status: config.status || 200,
    body: config.body ?? { status: "ok" },
    headers: config.headers ?? {},
    matchedRuleId: null,
  };
}

export function buildDynamicMockContext(input: {
  headers: Record<string, string>;
  queryParams: Record<string, string | string[]>;
  body: unknown;
  rawBodyText?: string;
  requestPath: string;
  patternPath: string;
}): DynamicMockContext {
  return {
    headers: input.headers,
    queryParams: input.queryParams,
    body: input.body,
    rawBodyText: input.rawBodyText,
    pathParams: extractPathParams(input.requestPath, input.patternPath),
  };
}
