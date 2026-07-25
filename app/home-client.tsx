"use client";

import React, {
  Children,
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  bracketMatching,
  defaultHighlightStyle,
  foldable,
  foldEffect,
  foldGutter,
  foldKeymap,
  forceParsing,
  indentOnInput,
  syntaxHighlighting,
  syntaxTree,
  unfoldAll,
} from "@codemirror/language";
import { json } from "@codemirror/lang-json";
import {
  defaultKeymap,
  history as codeMirrorHistory,
  historyKeymap,
} from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { cn } from "@/lib/utils";
import {
  analyzeImportFile,
  downloadTextFile,
  exportTimestamp,
  parseFileContent,
  routeConfigsFromImport,
  routeConfigsToOpenApi,
  stringifyYaml,
  type DetectedImport,
  type ExportFormat,
  type RouteConfigInput,
} from "@/lib/import-export";

const LOGS_PAGE_SIZE = 20;

type ApiRequestLog = {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  slug: string[];
  apiName: string;
  queryParams: Record<string, string | string[]>;
  proxyTargetUrl?: string;
  proxyResolvedUrl?: string;
  proxyClientId?: string;
  proxyClientName?: string;
  proxyServiceName?: string;
  configSource?: "route" | "api" | "none";
  overrodeApiProxy?: boolean;
  proxyClientOffline?: boolean;
  body: unknown;
  headers: Record<string, string>;
  responseStatus: number;
  responseBody: unknown;
  responseHeaders: Record<string, string>;
};

type ApiRouteStat = {
  id: string;
  method: string;
  path: string;
  apiName: string;
  count: number;
  firstTimestamp: string;
  lastTimestamp: string;
  overrideMode?: "mock" | "url" | "client";
  proxyClientId?: string;
};

type MockMatchSource = "header" | "query" | "path" | "body";
type MockBodyKind = "json" | "raw";
type MockOperator =
  | "equals"
  | "notEquals"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "exists"
  | "notExists";

type DynamicMockCondition = {
  source: MockMatchSource;
  key?: string;
  bodyKind?: MockBodyKind;
  operator: MockOperator;
  value?: string;
};

type MockJoinOperator = "and" | "or";

type DynamicMockRule = {
  id: string;
  conditions: DynamicMockCondition[];
  joins: MockJoinOperator[];
  status: number;
  body: unknown;
  headers: Record<string, string>;
};

function emptyMockCondition(): DynamicMockCondition {
  return {
    source: "query",
    key: "",
    operator: "equals",
    value: "",
  };
}

function normalizeDynamicRule(raw: unknown): DynamicMockRule | null {
  if (!raw || typeof raw !== "object") return null;
  const rule = raw as Partial<DynamicMockRule> & {
    condition?: DynamicMockCondition;
  };
  let conditions: DynamicMockCondition[] = [];
  if (Array.isArray(rule.conditions) && rule.conditions.length > 0) {
    conditions = rule.conditions.map((c) => ({
      source: c?.source ?? "query",
      key: c?.key,
      bodyKind: c?.bodyKind === "raw" ? "raw" : c?.bodyKind === "json" ? "json" : c?.bodyKind,
      operator: c?.operator ?? "equals",
      value: c?.value,
    }));
  } else if (rule.condition && typeof rule.condition === "object") {
    conditions = [
      {
        source: rule.condition.source ?? "query",
        key: rule.condition.key,
        bodyKind:
          rule.condition.bodyKind === "raw"
            ? "raw"
            : rule.condition.bodyKind === "json"
              ? "json"
              : rule.condition.bodyKind,
        operator: rule.condition.operator ?? "equals",
        value: rule.condition.value,
      },
    ];
  }
  if (conditions.length === 0) return null;
  const needed = conditions.length - 1;
  const rawJoins = Array.isArray(rule.joins) ? rule.joins : [];
  const joins: MockJoinOperator[] = [];
  for (let i = 0; i < needed; i++) {
    joins.push(rawJoins[i] === "or" ? "or" : "and");
  }
  return {
    id:
      typeof rule.id === "string" && rule.id.trim()
        ? rule.id.trim()
        : newDynamicRuleId(),
    conditions,
    joins,
    status: typeof rule.status === "number" ? rule.status : 200,
    body: rule.body ?? { status: "ok" },
    headers:
      rule.headers && typeof rule.headers === "object" ? rule.headers : {},
  };
}

function normalizeDynamicRules(rules: unknown): DynamicMockRule[] {
  if (!Array.isArray(rules)) return [];
  return rules
    .map(normalizeDynamicRule)
    .filter((r): r is DynamicMockRule => r != null);
}

function conditionDraftKey(ruleId: string, index: number) {
  return `${ruleId}:${index}`;
}

function remapDraftKeysAfterRemove(
  keys: string[],
  ruleId: string,
  removedIndex: number,
): string[] {
  const prefix = `${ruleId}:`;
  return keys
    .map((key) => {
      if (!key.startsWith(prefix)) return key;
      const idx = Number(key.slice(prefix.length));
      if (!Number.isFinite(idx) || idx === removedIndex) return null;
      if (idx > removedIndex) return conditionDraftKey(ruleId, idx - 1);
      return key;
    })
    .filter((key): key is string => key != null);
}

type ApiRouteConfig = {
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
  explicitlyConfigured?: boolean;
  mockMode?: "static" | "dynamic";
  dynamicRules?: DynamicMockRule[];
};

type ApiConfig = {
  apiName: string;
  proxyMode?: boolean;
  proxyUrl?: string;
  proxyToClient?: boolean;
  proxyClientId?: string;
  proxyServiceName?: string;
  sortOrder?: number;
};

type ProxyServiceInfo = {
  name: string;
  port: number;
  host: string;
};

type ProxyClientInfo = {
  clientId: string;
  clientName: string;
  serverName: string;
  localServices: ProxyServiceInfo[];
  connectedAt: string;
  lastHeartbeat: string;
  status: "online" | "offline";
};

type ProxyModeType = "disabled" | "url" | "client";

function normalizePathFront(path: string): string {
  if (!path) return "/";
  let result = path.trim();
  if (!result.startsWith("/")) result = `/${result}`;
  if (result.length > 1 && result.endsWith("/")) {
    result = result.slice(0, -1);
  }
  return result;
}

function isPathParamSegmentFront(seg: string): boolean {
  return seg === "*" || (seg.startsWith(":") && seg.length > 1);
}

function pathHasParamsFront(path: string): boolean {
  return path.split("/").filter(Boolean).some(isPathParamSegmentFront);
}

function listPathParamNames(path: string): string[] {
  return path
    .split("/")
    .filter(Boolean)
    .filter((s) => s.startsWith(":") && s.length > 1)
    .map((s) => s.slice(1));
}

function isValidParamName(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

function newDynamicRuleId(): string {
  return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function statusPillClass(status: number): string {
  if (status >= 200 && status < 300) {
    return "bg-emerald-600 text-white dark:bg-emerald-500 dark:text-zinc-950";
  }
  if (status >= 300 && status < 400) {
    return "bg-blue-600 text-white dark:bg-blue-500 dark:text-zinc-950";
  }
  if (status >= 400 && status < 500) {
    return "bg-amber-500 text-zinc-950 dark:bg-amber-400 dark:text-zinc-950";
  }
  if (status >= 500 && status < 600) {
    return "bg-red-600 text-white dark:bg-red-500 dark:text-zinc-950";
  }
  if (status >= 100 && status < 200) {
    return "bg-cyan-600 text-white dark:bg-cyan-500 dark:text-zinc-950";
  }
  return "bg-zinc-700 text-white dark:bg-zinc-300 dark:text-zinc-950";
}

type ResponseModeBadge = "mock" | "url" | "client";
type ResponseModeBadgeVariant = "filled" | "outline";

function responseModeBadgeClass(
  mode: ResponseModeBadge,
  variant: ResponseModeBadgeVariant = "filled",
  offline = false,
): string {
  if (offline) {
    return cn(
      "ml-2 inline-flex shrink-0 items-center rounded px-1 py-px font-sans text-[8px] font-semibold uppercase tracking-wide",
      variant === "filled"
        ? "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
        : "border border-zinc-400/70 bg-transparent text-zinc-500 dark:border-zinc-600 dark:text-zinc-500",
    );
  }
  return cn(
    "ml-2 inline-flex shrink-0 items-center rounded px-1 py-px font-sans text-[8px] font-semibold uppercase tracking-wide",
    variant === "filled" &&
      mode === "mock" &&
      "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
    variant === "filled" &&
      mode === "url" &&
      "bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-300",
    variant === "filled" &&
      mode === "client" &&
      "bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300",
    variant === "outline" &&
      mode === "mock" &&
      "border border-amber-400/70 bg-transparent text-amber-700 dark:border-amber-500/50 dark:text-amber-300",
    variant === "outline" &&
      mode === "url" &&
      "border border-violet-400/70 bg-transparent text-violet-700 dark:border-violet-500/50 dark:text-violet-300",
    variant === "outline" &&
      mode === "client" &&
      "border border-blue-400/70 bg-transparent text-blue-700 dark:border-blue-500/50 dark:text-blue-300",
  );
}

function tableRowZebraClass(index: number): string {
  return index % 2 === 0
    ? "bg-white dark:bg-zinc-950"
    : "bg-zinc-50 dark:bg-zinc-900/70";
}

function tableHeadClass(): string {
  return "sticky top-0 bg-zinc-200/90 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-100";
}

function tableHeadCellClass(): string {
  return "border-b border-zinc-300 px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide dark:border-zinc-600";
}

type HeaderRow = { id: string; name: string; value: string };

function newHeaderRowId() {
  return `h-${Math.random().toString(36).slice(2, 9)}`;
}

function toFlatStringRecord(value: unknown): Record<string, string> {
  const raw = toStringRecord(value);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(raw)) {
    out[key] = Array.isArray(item) ? item.join(", ") : item;
  }
  return out;
}

function recordToHeaderRows(headers: Record<string, string>): HeaderRow[] {
  const rows = Object.entries(headers).map(([name, value]) => ({
    id: newHeaderRowId(),
    name,
    value: String(value ?? ""),
  }));
  return [...rows, { id: newHeaderRowId(), name: "", value: "" }];
}

function headerRowsToRecord(rows: HeaderRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    out[name] = row.value;
  }
  return out;
}

function headersRecordEqual(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

function normalizeHeaderRows(rows: HeaderRow[]): HeaderRow[] {
  const filled = rows.filter((row) => row.name.trim() || row.value.trim());
  return [...filled, { id: newHeaderRowId(), name: "", value: "" }];
}

type ConditionStep =
  | "source"
  | "key"
  | "bodyKind"
  | "field"
  | "operator"
  | "value";

const MOCK_OPERATORS: MockOperator[] = [
  "equals",
  "notEquals",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "exists",
  "notExists",
];

const MOCK_SOURCES: MockMatchSource[] = ["header", "query", "path", "body"];

function operatorNeedsValue(operator: MockOperator): boolean {
  return operator !== "exists" && operator !== "notExists";
}

function nextConditionStep(
  condition: DynamicMockCondition,
  after: ConditionStep | null,
): ConditionStep | null {
  const order = (step: ConditionStep | null): ConditionStep | null => {
    if (step === null) return "source";
    if (step === "source") {
      if (condition.source === "header" || condition.source === "query") {
        return "key";
      }
      if (condition.source === "path") return "key";
      if (condition.source === "body") return "bodyKind";
      return "source";
    }
    if (step === "bodyKind") {
      return (condition.bodyKind ?? "json") === "json" ? "field" : "operator";
    }
    if (step === "key" || step === "field") return "operator";
    if (step === "operator") {
      return operatorNeedsValue(condition.operator) ? "value" : null;
    }
    return null;
  };
  return order(after);
}

function clearConditionAfterStep(
  condition: DynamicMockCondition,
  step: ConditionStep,
  pathParams: string[],
): DynamicMockCondition {
  if (step === "source") {
    return {
      source: condition.source,
      operator: "equals",
      key:
        condition.source === "path"
          ? pathParams[0] ?? ""
          : condition.source === "body"
            ? undefined
            : "",
      bodyKind: condition.source === "body" ? "json" : undefined,
      value: undefined,
    };
  }
  if (step === "bodyKind") {
    return {
      ...condition,
      key:
        (condition.bodyKind ?? "json") === "json"
          ? condition.key ?? ""
          : undefined,
      operator: "equals",
      value: undefined,
    };
  }
  if (step === "key" || step === "field") {
    return {
      ...condition,
      operator: "equals",
      value: undefined,
    };
  }
  if (step === "operator") {
    return {
      ...condition,
      value: operatorNeedsValue(condition.operator)
        ? condition.value ?? ""
        : undefined,
    };
  }
  return { ...condition };
}

function inferCompletedConditionSteps(
  condition: DynamicMockCondition,
  draft: boolean,
): ConditionStep[] {
  if (draft) return [];
  const steps: ConditionStep[] = ["source"];
  if (condition.source === "header" || condition.source === "query") {
    steps.push("key");
  } else if (condition.source === "path") {
    if (condition.key) steps.push("key");
    else return steps;
  } else if (condition.source === "body") {
    steps.push("bodyKind");
    if ((condition.bodyKind ?? "json") === "json") steps.push("field");
  }
  steps.push("operator");
  if (operatorNeedsValue(condition.operator)) steps.push("value");
  return steps;
}

function conditionPillClassName(active = false) {
  return cn(
    "inline-flex h-6 max-w-full items-center rounded px-1.5 font-mono text-[11px]",
    active
      ? "border border-zinc-400 bg-white text-zinc-900 dark:border-zinc-500 dark:bg-zinc-900 dark:text-zinc-50"
      : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700",
  );
}

function ConditionPillInput({
  value,
  onChange,
  pathParams,
  draft = false,
  onDraftConsumed,
}: {
  value: DynamicMockCondition;
  onChange: (next: DynamicMockCondition) => void;
  pathParams: string[];
  draft?: boolean;
  onDraftConsumed?: () => void;
}) {
  const [focused, setFocused] = useState(false);
  const [activeStep, setActiveStep] = useState<ConditionStep | null>(null);
  const [draftMode, setDraftMode] = useState(draft);
  const [completedSteps, setCompletedSteps] = useState<ConditionStep[]>(() =>
    draft ? [] : inferCompletedConditionSteps(value, false),
  );
  const [textDraft, setTextDraft] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const skipBlurCommit = useRef(false);

  useEffect(() => {
    setDraftMode(draft);
    if (draft) setCompletedSteps([]);
  }, [draft]);

  const effectiveActive =
    activeStep ??
    (focused && completedSteps.length === 0
      ? ("source" as ConditionStep)
      : null);

  useEffect(() => {
    if (
      effectiveActive === "key" ||
      effectiveActive === "field" ||
      effectiveActive === "value"
    ) {
      setTextDraft(
        effectiveActive === "value" ? (value.value ?? "") : (value.key ?? ""),
      );
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [effectiveActive]); // eslint-disable-line react-hooks/exhaustive-deps

  function consumeDraft() {
    if (draftMode) {
      setDraftMode(false);
      onDraftConsumed?.();
    }
  }

  function truncateCompletedBefore(step: ConditionStep) {
    const rank: Record<ConditionStep, number> = {
      source: 0,
      bodyKind: 1,
      key: 2,
      field: 2,
      operator: 3,
      value: 4,
    };
    setCompletedSteps((prev) =>
      prev.filter((item) => rank[item] < rank[step]),
    );
  }

  function openStep(step: ConditionStep) {
    const cleared = clearConditionAfterStep(value, step, pathParams);
    truncateCompletedBefore(step);
    if (step === "source") {
      onChange({
        source: "query",
        operator: "equals",
        key: "",
        value: "",
      });
      setDraftMode(true);
      setActiveStep("source");
      return;
    }
    onChange(cleared);
    setActiveStep(step);
  }

  function commitSource(source: MockMatchSource) {
    consumeDraft();
    const next: DynamicMockCondition = {
      source,
      operator: "equals",
      key:
        source === "path"
          ? pathParams[0] ?? ""
          : source === "body"
            ? undefined
            : "",
      bodyKind: source === "body" ? "json" : undefined,
      value: undefined,
    };
    onChange(next);
    if (source === "path" && pathParams.length > 0) {
      setCompletedSteps(["source", "key"]);
      setActiveStep("operator");
    } else {
      setCompletedSteps(["source"]);
      setActiveStep(nextConditionStep(next, "source"));
    }
  }

  function commitBodyKind(bodyKind: MockBodyKind) {
    const next: DynamicMockCondition = {
      ...value,
      bodyKind,
      key: bodyKind === "json" ? "" : undefined,
      operator: "equals",
      value: undefined,
    };
    onChange(next);
    setCompletedSteps(["source", "bodyKind"]);
    setActiveStep(nextConditionStep(next, "bodyKind"));
  }

  function commitKeyOrField(raw: string) {
    const from: ConditionStep =
      value.source === "body" && (value.bodyKind ?? "json") === "json"
        ? "field"
        : "key";
    const next: DynamicMockCondition = {
      ...value,
      key: raw,
      operator: "equals",
      value: undefined,
    };
    onChange(next);
    setCompletedSteps((prev) => {
      const base = prev.filter((s) => s !== "operator" && s !== "value");
      return base.includes(from) ? base : [...base, from];
    });
    setActiveStep(nextConditionStep(next, from));
  }

  function commitOperator(operator: MockOperator) {
    const next: DynamicMockCondition = {
      ...value,
      operator,
      value: operatorNeedsValue(operator) ? "" : undefined,
    };
    onChange(next);
    setCompletedSteps((prev) => {
      const withoutTail = prev.filter((s) => s !== "operator" && s !== "value");
      return [...withoutTail, "operator"];
    });
    setActiveStep(nextConditionStep(next, "operator"));
  }

  function commitValue(raw: string) {
    onChange({ ...value, value: raw });
    setCompletedSteps((prev) =>
      prev.includes("value") ? prev : [...prev, "value"],
    );
    setActiveStep(null);
  }

  function handleContainerClick() {
    setFocused(true);
    if (draftMode || completedSteps.length === 0) {
      setActiveStep("source");
      return;
    }
    if (!activeStep) {
      const next = nextConditionStep(
        value,
        completedSteps[completedSteps.length - 1] ?? null,
      );
      if (next) setActiveStep(next);
    }
  }

  const showPlaceholder =
    !focused &&
    completedSteps.length === 0 &&
    !activeStep &&
    !effectiveActive;

  const showSourcePill =
    completedSteps.includes("source") && effectiveActive !== "source";
  const showKeyPill =
    completedSteps.includes("key") &&
    effectiveActive !== "key" &&
    (value.source === "header" ||
      value.source === "query" ||
      value.source === "path");
  const showBodyKindPill =
    completedSteps.includes("bodyKind") && effectiveActive !== "bodyKind";
  const showFieldPill =
    completedSteps.includes("field") && effectiveActive !== "field";
  const showOperatorPill =
    completedSteps.includes("operator") && effectiveActive !== "operator";
  const showValuePill =
    completedSteps.includes("value") && effectiveActive !== "value";

  return (
    <div className="min-w-0 flex-1">
      <div
        ref={containerRef}
        role="group"
        tabIndex={0}
        onFocus={() => setFocused(true)}
        onBlur={(e) => {
          if (!containerRef.current?.contains(e.relatedTarget as Node)) {
            setFocused(false);
            if (
              !skipBlurCommit.current &&
              (activeStep === "key" ||
                activeStep === "field" ||
                activeStep === "value")
            ) {
              // blur no input filho já confirma
            } else if (completedSteps.length > 0 && activeStep === "source") {
              setActiveStep(null);
            }
          }
        }}
        onClick={handleContainerClick}
        className={cn(
          "flex min-h-8 w-full cursor-text flex-wrap items-center gap-1 rounded border border-zinc-300 bg-white px-1.5 py-0.5 dark:border-zinc-700 dark:bg-zinc-950",
          focused && "border-zinc-400 dark:border-zinc-500",
        )}
      >
        {showPlaceholder && (
          <span className="px-0.5 text-[11px] text-zinc-400">
            Clique para definir a condição
          </span>
        )}

        {showSourcePill && (
          <button
            type="button"
            className={conditionPillClassName()}
            onClick={(e) => {
              e.stopPropagation();
              openStep("source");
            }}
          >
            {value.source}
          </button>
        )}

        {showBodyKindPill && (
          <button
            type="button"
            className={conditionPillClassName()}
            onClick={(e) => {
              e.stopPropagation();
              openStep("bodyKind");
            }}
          >
            {value.bodyKind ?? "json"}
          </button>
        )}

        {showKeyPill && (
          <button
            type="button"
            className={conditionPillClassName()}
            onClick={(e) => {
              e.stopPropagation();
              openStep("key");
            }}
          >
            {value.source === "path"
              ? `:${value.key || "?"}`
              : value.key || "chave"}
          </button>
        )}

        {showFieldPill && (
          <button
            type="button"
            className={conditionPillClassName()}
            onClick={(e) => {
              e.stopPropagation();
              openStep("field");
            }}
          >
            {value.key || "body"}
          </button>
        )}

        {showOperatorPill && (
          <button
            type="button"
            className={conditionPillClassName()}
            onClick={(e) => {
              e.stopPropagation();
              openStep("operator");
            }}
          >
            {value.operator}
          </button>
        )}

        {showValuePill && (
          <button
            type="button"
            className={conditionPillClassName()}
            onClick={(e) => {
              e.stopPropagation();
              openStep("value");
            }}
          >
            {value.value || "valor"}
          </button>
        )}

        {effectiveActive === "source" && (
          <select
            autoFocus
            className={cn(conditionPillClassName(true), "cursor-pointer")}
            value=""
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              const source = e.target.value as MockMatchSource;
              if (source) commitSource(source);
            }}
          >
            <option value="" disabled>
              fonte
            </option>
            {MOCK_SOURCES.map((source) => (
              <option key={source} value={source}>
                {source}
              </option>
            ))}
          </select>
        )}

        {effectiveActive === "bodyKind" && (
          <select
            autoFocus
            className={cn(conditionPillClassName(true), "cursor-pointer")}
            value=""
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              const bodyKind = e.target.value as MockBodyKind;
              if (bodyKind) commitBodyKind(bodyKind);
            }}
          >
            <option value="" disabled>
              tipo
            </option>
            <option value="json">json</option>
            <option value="raw">raw</option>
          </select>
        )}

        {effectiveActive === "key" && value.source === "path" ? (
          pathParams.length === 0 ? (
            <span
              className="text-[11px] text-amber-600"
              onClick={(e) => e.stopPropagation()}
            >
              Sem :params
            </span>
          ) : (
            <select
              autoFocus
              className={cn(conditionPillClassName(true), "cursor-pointer")}
              value={value.key ?? ""}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                commitKeyOrField(e.target.value);
              }}
            >
              {pathParams.map((name) => (
                <option key={name} value={name}>
                  :{name}
                </option>
              ))}
            </select>
          )
        ) : null}

        {(effectiveActive === "key" &&
          (value.source === "header" || value.source === "query")) ||
        effectiveActive === "field" ||
        effectiveActive === "value" ? (
          <input
            ref={inputRef}
            type="text"
            value={textDraft}
            placeholder={
              effectiveActive === "field"
                ? "user.id"
                : effectiveActive === "value"
                  ? "valor"
                  : "chave"
            }
            className={cn(
              conditionPillClassName(true),
              "min-w-[4.5rem] flex-1 bg-transparent outline-none",
            )}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setTextDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                skipBlurCommit.current = true;
                if (effectiveActive === "value") commitValue(textDraft);
                else commitKeyOrField(textDraft);
                requestAnimationFrame(() => {
                  skipBlurCommit.current = false;
                });
              }
              if (e.key === "Escape") {
                setActiveStep(null);
              }
            }}
            onBlur={() => {
              if (skipBlurCommit.current) return;
              if (effectiveActive === "value") commitValue(textDraft);
              else if (
                effectiveActive === "key" ||
                effectiveActive === "field"
              ) {
                commitKeyOrField(textDraft);
              }
            }}
          />
        ) : null}

        {effectiveActive === "operator" && (
          <select
            autoFocus
            className={cn(conditionPillClassName(true), "cursor-pointer")}
            value=""
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              const operator = e.target.value as MockOperator;
              if (operator) commitOperator(operator);
            }}
          >
            <option value="" disabled>
              operador
            </option>
            {MOCK_OPERATORS.map((operator) => (
              <option key={operator} value={operator}>
                {operator}
              </option>
            ))}
          </select>
        )}
      </div>
      {value.source === "path" &&
        !draftMode &&
        pathParams.length === 0 &&
        completedSteps.includes("source") && (
          <p className="mt-1 text-[10px] text-amber-600">
            Este path não tem parâmetros (:id). Converta um segmento antes.
          </p>
        )}
    </div>
  );
}

function KeyValueViewer({
  label,
  data,
  defaultBodyMode = "table",
  defaultJsonCollapsed = false,
}: {
  label: string;
  data: Record<string, string | string[]>;
  defaultBodyMode?: DisplayBodyMode;
  defaultJsonCollapsed?: boolean;
}) {
  const [bulkOpen, setBulkOpen] = useState(defaultBodyMode === "bulk");
  const flat = toFlatStringRecord(data);
  const entries = Object.entries(flat);
  const bulkText = JSON.stringify(flat, null, 2);

  useEffect(() => {
    setBulkOpen(defaultBodyMode === "bulk");
  }, [defaultBodyMode]);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-5 items-center justify-between gap-2">
        <span className="text-[12px] font-semibold leading-none text-zinc-800 dark:text-zinc-100">
          {label}
        </span>
        <button
          type="button"
          className="text-[10px] font-medium text-zinc-500 underline-offset-2 hover:text-zinc-800 hover:underline dark:text-zinc-400 dark:hover:text-zinc-200"
          onClick={() => setBulkOpen((open) => !open)}
        >
          {bulkOpen ? "Table" : "Bulk"}
        </button>
      </div>
      {bulkOpen ? (
        <JsonBulkCodeEditor
          value={bulkText}
          readOnly
          defaultCollapsed={defaultJsonCollapsed}
        />
      ) : (
        <div className="flex max-h-60 flex-col overflow-hidden rounded border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-950">
          <div className="shrink-0 bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-100">
            <table className="min-w-full table-fixed border-separate border-spacing-0 text-[11px]">
              <thead>
                <tr>
                  <th className={tableHeadCellClass()}>Chave</th>
                  <th className={tableHeadCellClass()}>Valor</th>
                </tr>
              </thead>
            </table>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <table className="min-w-full table-fixed border-separate border-spacing-0 text-[11px]">
              <tbody>
                {entries.length === 0 ? (
                  <tr className={tableRowZebraClass(0)}>
                    <td
                      colSpan={2}
                      className="border-b border-zinc-100 px-2 py-1 text-zinc-500 dark:border-zinc-800 dark:text-zinc-400"
                    >
                      (vazio)
                    </td>
                  </tr>
                ) : (
                  entries.map(([key, value], index) => (
                    <tr key={key} className={tableRowZebraClass(index)}>
                      <td className="border-b border-zinc-100 px-2 py-1 font-mono text-zinc-700 dark:border-zinc-800 dark:text-zinc-200">
                        {key}
                      </td>
                      <td className="break-all border-b border-zinc-100 px-2 py-1 font-mono text-zinc-700 dark:border-zinc-800 dark:text-zinc-200">
                        {value}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function HeadersEditor({
  value,
  onChange,
  defaultBodyMode = "table",
  defaultJsonCollapsed = false,
}: {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  defaultBodyMode?: DisplayBodyMode;
  defaultJsonCollapsed?: boolean;
}) {
  const [rows, setRows] = useState(() => recordToHeaderRows(value));
  const [bulkOpen, setBulkOpen] = useState(defaultBodyMode === "bulk");
  const [bulkText, setBulkText] = useState(() =>
    JSON.stringify(value, null, 2),
  );

  useEffect(() => {
    setBulkOpen(defaultBodyMode === "bulk");
  }, [defaultBodyMode]);

  useEffect(() => {
    const fromRows = headerRowsToRecord(rows);
    if (!headersRecordEqual(value, fromRows)) {
      setRows(recordToHeaderRows(value));
      setBulkText(JSON.stringify(value, null, 2));
    }
    // Only re-sync when the external value changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function commitRows(nextRows: HeaderRow[]) {
    const normalized = normalizeHeaderRows(nextRows);
    setRows(normalized);
    const record = headerRowsToRecord(normalized);
    onChange(record);
    setBulkText(JSON.stringify(record, null, 2));
  }

  function updateRow(id: string, patch: Partial<Pick<HeaderRow, "name" | "value">>) {
    commitRows(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function removeRow(id: string) {
    commitRows(rows.filter((row) => row.id !== id));
  }

  function handleBulkTextChange(nextText: string) {
    setBulkText(nextText);
    try {
      const parsed = JSON.parse(nextText || "{}") as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return;
      }
      const record = toFlatStringRecord(parsed);
      setRows(recordToHeaderRows(record));
      onChange(record);
    } catch {
      // Mantém o rascunho inválido enquanto o usuário digita no bulk.
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-zinc-500">Headers</span>
        <button
          type="button"
          className="text-[10px] text-zinc-500 underline-offset-2 hover:text-zinc-700 hover:underline dark:hover:text-zinc-300"
          onClick={() => {
            if (!bulkOpen) {
              setBulkText(JSON.stringify(headerRowsToRecord(rows), null, 2));
            }
            setBulkOpen((open) => !open);
          }}
        >
          {bulkOpen ? "Table" : "Bulk"}
        </button>
      </div>
      {bulkOpen ? (
        <JsonBulkCodeEditor
          value={bulkText}
          onChange={handleBulkTextChange}
          defaultCollapsed={defaultJsonCollapsed}
        />
      ) : (
        <div className="max-h-60 overflow-auto rounded border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-950">
          <table className="min-w-full border-separate border-spacing-0 text-[11px]">
            <thead className={tableHeadClass()}>
              <tr>
                <th className={tableHeadCellClass()}>Chave</th>
                <th className={tableHeadCellClass()}>Valor</th>
                <th className={cn(tableHeadCellClass(), "w-7 px-1")} />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const isTrailingEmpty =
                  index === rows.length - 1 && !row.name && !row.value;
                return (
                  <tr
                    key={row.id}
                    className={tableRowZebraClass(index)}
                  >
                    <td className="border-b border-zinc-100 px-1 py-0.5 dark:border-zinc-800">
                      <input
                        type="text"
                        placeholder="Chave"
                        className="h-7 w-full bg-transparent px-1 font-mono text-[11px] text-zinc-800 placeholder:text-zinc-400 focus:outline-none dark:text-zinc-100"
                        value={row.name}
                        onChange={(e) =>
                          updateRow(row.id, { name: e.target.value })
                        }
                      />
                    </td>
                    <td className="border-b border-zinc-100 px-1 py-0.5 dark:border-zinc-800">
                      <input
                        type="text"
                        placeholder="Valor"
                        className="h-7 w-full bg-transparent px-1 font-mono text-[11px] text-zinc-800 placeholder:text-zinc-400 focus:outline-none dark:text-zinc-100"
                        value={row.value}
                        onChange={(e) =>
                          updateRow(row.id, { value: e.target.value })
                        }
                      />
                    </td>
                    <td className="border-b border-zinc-100 px-1 text-center dark:border-zinc-800">
                      {!isTrailingEmpty ? (
                        <button
                          type="button"
                          aria-label="Remover header"
                          className="text-[11px] text-zinc-400 hover:text-red-500"
                          onClick={() => removeRow(row.id)}
                        >
                          ✕
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

type JsonValueType =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "object"
  | "array";

type JsonBodyRow = {
  id: string;
  key: string;
  type: JsonValueType;
  value: string;
  children?: JsonBodyRow[];
};

type JsonBodyContainerMode = "object" | "array";

function newJsonBodyRowId() {
  return `j-${Math.random().toString(36).slice(2, 9)}`;
}

function emptyJsonBodyRow(): JsonBodyRow {
  return { id: newJsonBodyRowId(), key: "", type: "string", value: "" };
}

function isCompositeJsonType(
  type: JsonValueType,
): type is "object" | "array" {
  return type === "object" || type === "array";
}

/** Placeholder trailing row (no key/value, default string). */
function isBlankJsonBodyRow(row: JsonBodyRow): boolean {
  return (
    !row.key.trim() &&
    row.type === "string" &&
    !row.value.trim() &&
    !row.children?.length
  );
}

function detectJsonValueType(value: unknown): JsonValueType {
  if (value === null) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number" && Number.isFinite(value)) return "number";
  if (typeof value === "string") return "string";
  if (Array.isArray(value)) return "array";
  if (value && typeof value === "object") return "object";
  return "string";
}

function primitiveToCell(value: unknown, type: JsonValueType): string {
  if (type === "null") return "";
  if (type === "boolean") return value ? "true" : "false";
  if (type === "number") return String(value ?? "0");
  return String(value ?? "");
}

function cellToPrimitive(type: JsonValueType, raw: string): unknown {
  if (type === "null") return null;
  if (type === "boolean") return raw === "true";
  if (type === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  return raw;
}

function valueToJsonBodyRow(key: string, value: unknown): JsonBodyRow {
  const type = detectJsonValueType(value);
  if (type === "object") {
    return {
      id: newJsonBodyRowId(),
      key,
      type,
      value: "",
      children: objectToJsonBodyRows(value),
    };
  }
  if (type === "array") {
    return {
      id: newJsonBodyRowId(),
      key,
      type,
      value: "",
      children: arrayToJsonBodyRows(value as unknown[]),
    };
  }
  return {
    id: newJsonBodyRowId(),
    key,
    type,
    value: primitiveToCell(value, type),
  };
}

function objectToJsonBodyRows(value: unknown): JsonBodyRow[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [emptyJsonBodyRow()];
  }
  const rows = Object.entries(value as Record<string, unknown>).map(
    ([key, item]) => valueToJsonBodyRow(key, item),
  );
  return normalizeJsonBodyRows(rows, "object");
}

function arrayToJsonBodyRows(value: unknown[]): JsonBodyRow[] {
  const rows = value.map((item, index) =>
    valueToJsonBodyRow(String(index), item),
  );
  return normalizeJsonBodyRows(rows, "array");
}

function jsonBodyRowToValue(row: JsonBodyRow): unknown {
  if (row.type === "object") {
    return jsonBodyRowsToObject(row.children ?? []);
  }
  if (row.type === "array") {
    return jsonBodyRowsToArray(row.children ?? []);
  }
  return cellToPrimitive(row.type, row.value);
}

function jsonBodyRowsToObject(rows: JsonBodyRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    out[key] = jsonBodyRowToValue(row);
  }
  return out;
}

function jsonBodyRowsToArray(rows: JsonBodyRow[]): unknown[] {
  const out: unknown[] = [];
  for (const row of rows) {
    if (isBlankJsonBodyRow(row)) continue;
    out.push(jsonBodyRowToValue(row));
  }
  return out;
}

function normalizeJsonBodyRows(
  rows: JsonBodyRow[],
  mode: JsonBodyContainerMode,
): JsonBodyRow[] {
  const filled = rows
    .filter((row) => !isBlankJsonBodyRow(row))
    .map((row) => {
      if (!isCompositeJsonType(row.type)) {
        return {
          id: row.id,
          key: row.key,
          type: row.type,
          value: row.value,
        };
      }
      return {
        ...row,
        value: "",
        children: normalizeJsonBodyRows(
          row.children ?? [emptyJsonBodyRow()],
          row.type,
        ),
      };
    });

  if (mode === "array") {
    return [
      ...filled.map((row, index) => ({ ...row, key: String(index) })),
      emptyJsonBodyRow(),
    ];
  }

  return [...filled, emptyJsonBodyRow()];
}

function mapJsonBodyRows(
  rows: JsonBodyRow[],
  id: string,
  mapper: (row: JsonBodyRow) => JsonBodyRow | null,
): JsonBodyRow[] {
  const next: JsonBodyRow[] = [];
  for (const row of rows) {
    if (row.id === id) {
      const mapped = mapper(row);
      if (mapped) next.push(mapped);
      continue;
    }
    if (row.children) {
      next.push({
        ...row,
        children: mapJsonBodyRows(row.children, id, mapper),
      });
      continue;
    }
    next.push(row);
  }
  return next;
}

function coerceJsonBodyRowType(
  row: JsonBodyRow,
  nextType: JsonValueType,
): JsonBodyRow {
  if (nextType === row.type) return row;

  if (isCompositeJsonType(nextType)) {
    const currentValue = jsonBodyRowToValue(row);
    if (nextType === "object") {
      if (
        currentValue &&
        typeof currentValue === "object" &&
        !Array.isArray(currentValue)
      ) {
        return {
          ...row,
          type: "object",
          value: "",
          children: objectToJsonBodyRows(currentValue),
        };
      }
      if (typeof row.value === "string" && row.value.trim()) {
        try {
          const parsed = JSON.parse(row.value) as unknown;
          if (
            parsed &&
            typeof parsed === "object" &&
            !Array.isArray(parsed)
          ) {
            return {
              ...row,
              type: "object",
              value: "",
              children: objectToJsonBodyRows(parsed),
            };
          }
        } catch {
          /* ignore */
        }
      }
      return {
        ...row,
        type: "object",
        value: "",
        children: [emptyJsonBodyRow()],
      };
    }

    if (Array.isArray(currentValue)) {
      return {
        ...row,
        type: "array",
        value: "",
        children: arrayToJsonBodyRows(currentValue),
      };
    }
    if (typeof row.value === "string" && row.value.trim()) {
      try {
        const parsed = JSON.parse(row.value) as unknown;
        if (Array.isArray(parsed)) {
          return {
            ...row,
            type: "array",
            value: "",
            children: arrayToJsonBodyRows(parsed),
          };
        }
      } catch {
        /* ignore */
      }
    }
    return {
      ...row,
      type: "array",
      value: "",
      children: [emptyJsonBodyRow()],
    };
  }

  let nextValue = "";
  if (nextType === "boolean") nextValue = "true";
  else if (nextType === "number") nextValue = "0";
  else if (nextType === "string") {
    if (isCompositeJsonType(row.type)) {
      try {
        nextValue = JSON.stringify(jsonBodyRowToValue(row));
      } catch {
        nextValue = "";
      }
    } else if (row.type !== "null") {
      nextValue = row.value;
    }
  } else if (nextType === "null") {
    nextValue = "";
  }

  return {
    id: row.id,
    key: row.key,
    type: nextType,
    value: nextValue,
  };
}

function jsonBodiesEqual(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function formatJsonBody(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

function isJsonObjectRoot(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function JsonFoldChevron({
  expanded,
  onClick,
}: {
  expanded: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={expanded ? "Recolher" : "Expandir"}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="inline-flex h-5 w-4 shrink-0 items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
    >
      <span
        className={cn(
          "block text-[8px] leading-none transition-transform",
          expanded ? "rotate-0" : "-rotate-90",
        )}
      >
        ▼
      </span>
    </button>
  );
}

/** Conector em L estilo Threads: linha do pai até o filho. */
function JsonThreadBranch({ isLast }: { isLast: boolean }) {
  return (
    <span
      className="relative mr-0.5 inline-block h-7 w-3.5 shrink-0"
      aria-hidden
    >
      <span className="absolute top-0 left-[6px] h-[15px] w-px bg-zinc-300 dark:bg-zinc-600" />
      {!isLast ? (
        <span className="absolute top-[15px] bottom-0 left-[6px] w-px bg-zinc-300 dark:bg-zinc-600" />
      ) : null}
      <span className="absolute top-[13px] left-[6px] h-[7px] w-[9px] rounded-bl-[7px] border-b border-l border-zinc-300 dark:border-zinc-600" />
    </span>
  );
}

/**
 * Cópia 1:1 da geometria do JsonThreadBranch (que já funciona no body):
 * tronco reto + peça L pequena no ramo (não um L do tamanho do bloco inteiro).
 */
function LogThreadBlock({
  icon,
  title,
  titleAside,
  prelude,
  children,
}: {
  icon: ReactNode;
  title: string;
  titleAside?: ReactNode;
  prelude?: ReactNode;
  children: ReactNode;
}) {
  const items = Children.toArray(children).filter(Boolean);
  const preludeItems = Children.toArray(prelude).filter(Boolean);
  const hasPrelude = preludeItems.length > 0;

  // Mesmos números do JsonThreadBranch (left 6 → 10 numa col de 20)
  const rail = 10;
  // centro do label h-5
  const labelCenter = 10;
  // peça do canto — iguais ao body (7), braço só mais longo
  const corner = 7;
  const overlap = 2;
  const armWidth = 36;
  const labelGutter = 12;

  const railClass =
    "absolute w-px bg-zinc-400 dark:bg-zinc-500";

  return (
    <div className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-6">
      <div className="relative">
        <div className="relative z-10 flex h-5 w-5 items-center justify-center rounded-full border border-zinc-300 bg-white text-[10px] text-zinc-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200">
          {icon}
        </div>
        <span
          aria-hidden
          className={cn(railClass, "top-2.5 bottom-0")}
          style={{ left: rail }}
        />
      </div>
      <div className="flex min-h-5 items-center justify-between gap-2 border-b border-zinc-200 pb-2 dark:border-zinc-700">
        <div className="text-[13px] font-semibold tracking-wide text-zinc-900 dark:text-zinc-50">
          {title}
        </div>
        {titleAside}
      </div>

      {hasPrelude ? (
        <>
          <div className="relative">
            <span
              aria-hidden
              className={cn(railClass, "inset-y-0")}
              style={{ left: rail }}
            />
          </div>
          <div className="pt-3">{preludeItems}</div>
        </>
      ) : null}

      {items.map((child, index) => {
        const isLast = index === items.length - 1;
        const isFirst = index === 0;
        const padTop = isFirst ? 12 : 0;
        // equivalente ao top-[15px] do JsonThreadBranch
        const branchAt = padTop + labelCenter;

        return (
          <Fragment key={index}>
            <div
              className={cn("relative", isFirst && "pt-3", !isLast && "pb-3")}
            >
              {/* Tronco até o ramo — JsonThreadBranch: h-[15px] */}
              <span
                aria-hidden
                className={railClass}
                style={{ left: rail, top: 0, height: branchAt }}
              />
              {/* Continuação — JsonThreadBranch: top-[15px] bottom-0 */}
              {!isLast ? (
                <span
                  aria-hidden
                  className={railClass}
                  style={{ left: rail, top: branchAt, bottom: 0 }}
                />
              ) : null}
              {/* Peça L — JsonThreadBranch: top-[13px] h-[7px] w-[9px] rounded-bl-[7px] */}
              <span
                aria-hidden
                className="pointer-events-none absolute rounded-bl-[7px] border-b border-l border-zinc-400 dark:border-zinc-500"
                style={{
                  left: rail,
                  top: branchAt - overlap,
                  width: armWidth,
                  height: corner,
                }}
              />
            </div>
            <div
              className={cn(isFirst && "pt-3", !isLast && "pb-3")}
              style={{ paddingLeft: labelGutter }}
            >
              {child}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

function JsonThreadSpine({ continues }: { continues: boolean }) {
  return (
    <span className="relative mr-0.5 inline-block h-7 w-3.5 shrink-0" aria-hidden>
      {continues ? (
        <span className="absolute inset-y-0 left-[6px] w-px bg-zinc-300 dark:bg-zinc-600" />
      ) : null}
    </span>
  );
}

type FlatJsonBodyRow = {
  row: JsonBodyRow;
  depth: number;
  mode: JsonBodyContainerMode;
  isLastSibling: boolean;
  /** Em cada nível ancestral: se o fio vertical continua (ancestral não era o último). */
  ancestorSpine: boolean[];
};

function flattenJsonBodyRows(
  rows: JsonBodyRow[],
  mode: JsonBodyContainerMode,
  collapsedIds: Set<string>,
  depth = 0,
  ancestorSpine: boolean[] = [],
): FlatJsonBodyRow[] {
  const out: FlatJsonBodyRow[] = [];
  rows.forEach((row, index) => {
    const isLastSibling = index === rows.length - 1;
    out.push({ row, depth, mode, isLastSibling, ancestorSpine });
    const nestedMode = isCompositeJsonType(row.type) ? row.type : null;
    if (nestedMode && !collapsedIds.has(row.id)) {
      out.push(
        ...flattenJsonBodyRows(
          row.children ?? [emptyJsonBodyRow()],
          nestedMode,
          collapsedIds,
          depth + 1,
          [...ancestorSpine, !isLastSibling],
        ),
      );
    }
  });
  return out;
}

/** Colapsa só objetos/arrays filhos diretos da raiz (raiz permanece aberta). */
function foldJsonRootChildren(view: EditorView) {
  const tree = syntaxTree(view.state);
  let root = tree.topNode.firstChild;
  while (root && root.name !== "Object" && root.name !== "Array") {
    root = root.nextSibling;
  }
  if (!root) return;

  const ranges: { from: number; to: number }[] = [];
  const tryFoldAt = (pos: number) => {
    const line = view.state.doc.lineAt(pos);
    const range = foldable(view.state, line.from, line.to);
    if (range) ranges.push(range);
  };

  if (root.name === "Object") {
    for (let child = root.firstChild; child; child = child.nextSibling) {
      if (child.name !== "Property") continue;
      let value = child.lastChild;
      while (value && value.name === "⚠") value = value.prevSibling;
      if (value && (value.name === "Object" || value.name === "Array")) {
        tryFoldAt(value.from);
      }
    }
  } else {
    for (let child = root.firstChild; child; child = child.nextSibling) {
      if (child.name === "Object" || child.name === "Array") {
        tryFoldAt(child.from);
      }
    }
  }

  if (ranges.length) {
    view.dispatch({
      effects: ranges.map((range) => foldEffect.of(range)),
    });
  }
}

function applyJsonBulkFold(view: EditorView, collapsed: boolean) {
  forceParsing(view, view.state.doc.length, 150);
  // Garante árvore pronta antes do fold (parser pode terminar no próximo tick)
  requestAnimationFrame(() => {
    forceParsing(view, view.state.doc.length, 150);
    unfoldAll(view);
    if (collapsed) foldJsonRootChildren(view);
  });
}

function JsonBulkCodeEditor({
  value,
  onChange,
  readOnly = false,
  defaultCollapsed = false,
}: {
  value: string;
  onChange?: (next: string) => void;
  readOnly?: boolean;
  defaultCollapsed?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const valueRef = useRef(value);
  const collapsedRef = useRef(defaultCollapsed);
  onChangeRef.current = onChange;
  valueRef.current = value;
  collapsedRef.current = defaultCollapsed;

  useEffect(() => {
    if (!hostRef.current) return;

    const prefersDark =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;

    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: valueRef.current,
        extensions: [
          lineNumbers(),
          ...(readOnly
            ? []
            : [highlightActiveLine(), highlightActiveLineGutter()]),
          foldGutter({
            openText: "▼",
            closedText: "▶",
          }),
          bracketMatching(),
          ...(readOnly
            ? [
                EditorState.readOnly.of(true),
                EditorView.editable.of(false),
                keymap.of([...foldKeymap]),
              ]
            : [
                indentOnInput(),
                codeMirrorHistory(),
                keymap.of([
                  ...defaultKeymap,
                  ...historyKeymap,
                  ...foldKeymap,
                ]),
                EditorView.updateListener.of((update) => {
                  if (!update.docChanged) return;
                  onChangeRef.current?.(update.state.doc.toString());
                }),
              ]),
          json(),
          ...(prefersDark
            ? [oneDark]
            : [syntaxHighlighting(defaultHighlightStyle, { fallback: true })]),
          EditorView.theme({
            "&": {
              fontSize: "11px",
              maxHeight: "18rem",
            },
            "&.cm-editor": {
              outline: "none",
            },
            "&.cm-editor.cm-focused": {
              outline: "none",
            },
            ".cm-scroller": {
              overflow: "auto",
              fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
              lineHeight: "1.55",
            },
            ".cm-content": {
              padding: "6px 0",
            },
            ".cm-gutters": {
              border: "none",
            },
            ".cm-foldGutter .cm-gutterElement": {
              padding: "0 2px",
              fontSize: "8px",
              lineHeight: "1.55",
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    applyJsonBulkFold(view, collapsedRef.current);

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
    // Valor externo (não digitação local): reaplica preferência de colapso
    applyJsonBulkFold(view, collapsedRef.current);
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    applyJsonBulkFold(view, defaultCollapsed);
  }, [defaultCollapsed]);

  return (
    <div
      ref={hostRef}
      className="overflow-hidden rounded border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-950"
    />
  );
}

function JsonBodyTypeSelect({
  value,
  onChange,
}: {
  value: JsonValueType;
  onChange: (next: JsonValueType) => void;
}) {
  return (
    <select
      className="h-7 w-full bg-transparent px-0.5 text-[10px] text-zinc-700 focus:outline-none dark:text-zinc-200"
      value={value}
      onChange={(e) => onChange(e.target.value as JsonValueType)}
    >
      <option value="string">string</option>
      <option value="number">number</option>
      <option value="boolean">boolean</option>
      <option value="null">null</option>
      <option value="object">object</option>
      <option value="array">array</option>
    </select>
  );
}

function JsonBodyValueCell({
  row,
  collapsed,
  onChange,
  readOnly = false,
  autoFocus = false,
}: {
  row: JsonBodyRow;
  collapsed?: boolean;
  onChange: (value: string) => void;
  readOnly?: boolean;
  autoFocus?: boolean;
}) {
  if (row.type === "boolean") {
    if (readOnly) {
      return (
        <span className="px-1 font-mono text-[11px] text-zinc-800 dark:text-zinc-100">
          {row.value === "false" ? "false" : "true"}
        </span>
      );
    }
    return (
      <select
        autoFocus={autoFocus}
        className="h-7 w-full bg-transparent px-1 font-mono text-[11px] text-zinc-800 focus:outline-none dark:text-zinc-100"
        value={row.value === "false" ? "false" : "true"}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (row.type === "null") {
    return (
      <span className="px-1 font-mono text-[11px] text-zinc-400">null</span>
    );
  }
  if (isCompositeJsonType(row.type)) {
    const count = (row.children ?? []).filter((c) => !isBlankJsonBodyRow(c))
      .length;
    if (collapsed) {
      return (
        <span className="px-1 font-mono text-[11px] text-zinc-400">
          {row.type === "object" ? `{ ↔ ${count} ↔ }` : `[ ↔ ${count} ↔ ]`}
        </span>
      );
    }
    return (
      <span className="px-1 font-mono text-[11px] text-zinc-400">
        {row.type === "object" ? `{ ${count} }` : `[ ${count} ]`}
      </span>
    );
  }
  if (readOnly) {
    return (
      <span className="break-all px-1 font-mono text-[11px] text-zinc-800 dark:text-zinc-100">
        {row.value}
      </span>
    );
  }
  return (
    <input
      type={row.type === "number" ? "number" : "text"}
      placeholder="Valor"
      autoFocus={autoFocus}
      className="h-7 w-full bg-transparent px-1 font-mono text-[11px] text-zinc-800 placeholder:text-zinc-400 focus:outline-none dark:text-zinc-100"
      value={row.value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function stripBlankJsonBodyRows(rows: JsonBodyRow[]): JsonBodyRow[] {
  return rows
    .filter((row) => !isBlankJsonBodyRow(row))
    .map((row) =>
      row.children
        ? { ...row, children: stripBlankJsonBodyRows(row.children) }
        : row,
    );
}

/** IDs de object/array só no nível raiz (não desce nos filhos). */
function collectCompositeJsonBodyRowIds(rows: JsonBodyRow[]): string[] {
  return rows
    .filter((row) => isCompositeJsonType(row.type))
    .map((row) => row.id);
}

type DisplayBodyMode = "table" | "bulk";

function JsonBodyRowsTable({
  rows,
  mode,
  collapsedIds,
  onToggleCollapsed,
  onChange,
  readOnly = false,
}: {
  rows: JsonBodyRow[];
  mode: JsonBodyContainerMode;
  collapsedIds: Set<string>;
  onToggleCollapsed: (id: string) => void;
  onChange: (next: JsonBodyRow[]) => void;
  readOnly?: boolean;
}) {
  const sourceRows = readOnly ? stripBlankJsonBodyRows(rows) : rows;
  const flatRows = flattenJsonBodyRows(sourceRows, mode, collapsedIds);
  const [draftingBlankId, setDraftingBlankId] = useState<string | null>(null);

  function commit(nextRows: JsonBodyRow[]) {
    onChange(normalizeJsonBodyRows(nextRows, mode));
  }

  function updateRow(
    id: string,
    patch: Partial<Pick<JsonBodyRow, "key" | "type" | "value">>,
  ) {
    commit(
      mapJsonBodyRows(rows, id, (row) => {
        if (patch.type && patch.type !== row.type) {
          return coerceJsonBodyRowType(
            { ...row, ...patch, type: row.type },
            patch.type,
          );
        }
        return { ...row, ...patch };
      }),
    );
  }

  function removeRow(id: string) {
    commit(mapJsonBodyRows(rows, id, () => null));
  }

  function startDraftingBlank(id: string) {
    setDraftingBlankId(id);
  }

  const colgroup = (
    <colgroup>
      <col className="w-[40%]" />
      <col className="w-24" />
      <col />
      <col className="w-7" />
    </colgroup>
  );

  return (
    <div className="flex max-h-96 flex-col overflow-hidden rounded border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-950">
      <div className="shrink-0 bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-100">
        <table className="min-w-full table-fixed border-separate border-spacing-0 text-[11px]">
          {colgroup}
          <thead>
            <tr>
              <th className={tableHeadCellClass()}>Chave</th>
              <th className={tableHeadCellClass()}>Tipo</th>
              <th className={tableHeadCellClass()}>Valor</th>
              <th className={cn(tableHeadCellClass(), "px-1")} />
            </tr>
          </thead>
        </table>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="min-w-full table-fixed border-separate border-spacing-0 text-[11px]">
          {colgroup}
          <tbody>
            {flatRows.map(
              (
                { row, depth, mode: rowMode, isLastSibling, ancestorSpine },
                index,
              ) => {
                const isTrailingEmpty =
                  isLastSibling && isBlankJsonBodyRow(row);
                const isDraftingBlank =
                  isTrailingEmpty && draftingBlankId === row.id;
                const showAddAction =
                  isTrailingEmpty && !readOnly && !isDraftingBlank;
                const nestedMode = isCompositeJsonType(row.type)
                  ? row.type
                  : null;
                const collapsed = nestedMode
                  ? collapsedIds.has(row.id)
                  : false;

                if (showAddAction) {
                  return (
                    <tr key={row.id} className={tableRowZebraClass(index)}>
                      <td
                        colSpan={4}
                        className="border-b border-zinc-100 px-1 py-0.5 dark:border-zinc-800"
                      >
                        <div className="flex min-w-0 items-center gap-0.5">
                          {ancestorSpine.map((continues, spineIndex) => (
                            <JsonThreadSpine
                              key={spineIndex}
                              continues={continues}
                            />
                          ))}
                          {depth > 0 ? (
                            <JsonThreadBranch isLast={isLastSibling} />
                          ) : null}
                          <span className="inline-block w-4 shrink-0" />
                          <button
                            type="button"
                            className="h-7 px-1 text-left text-[11px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                            onClick={() => startDraftingBlank(row.id)}
                          >
                            + Adicionar
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                }

                return (
                  <tr key={row.id} className={tableRowZebraClass(index)}>
                    <td className="border-b border-zinc-100 px-1 py-0.5 dark:border-zinc-800">
                      <div className="flex min-w-0 items-center gap-0.5">
                        {ancestorSpine.map((continues, spineIndex) => (
                          <JsonThreadSpine
                            key={spineIndex}
                            continues={continues}
                          />
                        ))}
                        {depth > 0 ? (
                          <JsonThreadBranch isLast={isLastSibling} />
                        ) : null}
                        {nestedMode ? (
                          <JsonFoldChevron
                            expanded={!collapsed}
                            onClick={() => onToggleCollapsed(row.id)}
                          />
                        ) : (
                          <span className="inline-block w-4 shrink-0" />
                        )}
                        {rowMode === "array" || readOnly ? (
                          <span className="px-1 font-mono text-[11px] text-zinc-700 dark:text-zinc-200">
                            {rowMode === "array" ? row.key : row.key || "—"}
                          </span>
                        ) : (
                          <input
                            type="text"
                            placeholder="Chave"
                            autoFocus={isDraftingBlank}
                            className="h-7 min-w-0 flex-1 bg-transparent px-1 font-mono text-[11px] text-zinc-800 placeholder:text-zinc-400 focus:outline-none dark:text-zinc-100"
                            value={row.key}
                            onChange={(e) =>
                              updateRow(row.id, { key: e.target.value })
                            }
                          />
                        )}
                      </div>
                    </td>
                    <td className="border-b border-zinc-100 px-1 py-0.5 dark:border-zinc-800">
                      {readOnly ? (
                        <span className="px-0.5 font-mono text-[10px] text-zinc-500">
                          {row.type}
                        </span>
                      ) : (
                        <JsonBodyTypeSelect
                          value={row.type}
                          onChange={(type) => updateRow(row.id, { type })}
                        />
                      )}
                    </td>
                    <td className="border-b border-zinc-100 px-1 py-0.5 dark:border-zinc-800">
                      <JsonBodyValueCell
                        row={row}
                        collapsed={collapsed}
                        readOnly={readOnly}
                        autoFocus={isDraftingBlank && rowMode === "array"}
                        onChange={(value) => updateRow(row.id, { value })}
                      />
                    </td>
                    <td className="border-b border-zinc-100 px-1 text-center dark:border-zinc-800">
                      {!readOnly && !isTrailingEmpty ? (
                        <button
                          type="button"
                          aria-label="Remover campo"
                          className="text-[11px] text-zinc-400 hover:text-red-500"
                          onClick={() => removeRow(row.id)}
                        >
                          ✕
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              },
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function JsonBodyEditor({
  value,
  onChange,
  defaultBodyMode = "table",
  defaultJsonCollapsed = false,
}: {
  value: unknown;
  onChange: (next: unknown) => void;
  defaultBodyMode?: DisplayBodyMode;
  defaultJsonCollapsed?: boolean;
}) {
  const rootIsObject = isJsonObjectRoot(value);
  const [rows, setRows] = useState(() => objectToJsonBodyRows(value));
  const [bulkOpen, setBulkOpen] = useState(
    () => !rootIsObject || defaultBodyMode === "bulk",
  );
  const [bulkText, setBulkText] = useState(() => formatJsonBody(value));
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => {
    if (!defaultJsonCollapsed || !rootIsObject) return new Set();
    return new Set(
      collectCompositeJsonBodyRowIds(
        stripBlankJsonBodyRows(objectToJsonBodyRows(value)),
      ),
    );
  });

  useEffect(() => {
    if (isJsonObjectRoot(value)) {
      const fromRows = jsonBodyRowsToObject(rows);
      if (!jsonBodiesEqual(value, fromRows)) {
        const nextRows = objectToJsonBodyRows(value);
        setRows(nextRows);
        setCollapsedIds(
          defaultJsonCollapsed
            ? new Set(
                collectCompositeJsonBodyRowIds(
                  stripBlankJsonBodyRows(nextRows),
                ),
              )
            : new Set(),
        );
      }
      try {
        const fromBulk = JSON.parse(bulkText || "null") as unknown;
        if (!jsonBodiesEqual(value, fromBulk)) {
          setBulkText(formatJsonBody(value));
          setBulkError(null);
        }
      } catch {
        // Mantém o rascunho inválido enquanto o usuário digita no bulk.
      }
    } else {
      setBulkText(formatJsonBody(value));
      setBulkOpen(true);
      setBulkError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    if (isJsonObjectRoot(value)) {
      setBulkOpen(defaultBodyMode === "bulk");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultBodyMode]);

  useEffect(() => {
    if (!isJsonObjectRoot(value)) return;
    setCollapsedIds(
      defaultJsonCollapsed
        ? new Set(
            collectCompositeJsonBodyRowIds(stripBlankJsonBodyRows(rows)),
          )
        : new Set(),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultJsonCollapsed]);

  function commitRows(nextRows: JsonBodyRow[]) {
    const normalized = normalizeJsonBodyRows(nextRows, "object");
    setRows(normalized);
    const obj = jsonBodyRowsToObject(normalized);
    onChange(obj);
    setBulkText(formatJsonBody(obj));
    setBulkError(null);
  }

  function toggleCollapsedId(id: string) {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleBulkTextChange(nextText: string) {
    setBulkText(nextText);
    try {
      const parsed = JSON.parse(nextText || "null") as unknown;
      onChange(parsed);
      setBulkError(null);
    } catch {
      setBulkError("JSON inválido");
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-zinc-500">Body</span>
        <button
          type="button"
          className="text-[10px] text-zinc-500 underline-offset-2 hover:text-zinc-700 hover:underline dark:hover:text-zinc-300"
          onClick={() => {
            if (bulkOpen) {
              try {
                const parsed = JSON.parse(bulkText || "null") as unknown;
                if (!isJsonObjectRoot(parsed)) {
                  setBulkError(
                    "Use um objeto JSON ({...}) para editar em Table",
                  );
                  return;
                }
                onChange(parsed);
                setRows(objectToJsonBodyRows(parsed));
                setBulkOpen(false);
                setBulkError(null);
              } catch {
                setBulkError("JSON inválido");
              }
              return;
            }
            setBulkText(
              formatJsonBody(
                isJsonObjectRoot(value)
                  ? jsonBodyRowsToObject(rows)
                  : value,
              ),
            );
            setBulkError(null);
            setBulkOpen(true);
          }}
        >
          {bulkOpen ? "Table" : "Bulk"}
        </button>
      </div>
      {bulkOpen ? (
        <div className="flex flex-col gap-1">
          {!isJsonObjectRoot(value) && (
            <p className="text-[10px] text-zinc-500">
              Array ou valor não-objeto: edite em Bulk. Table disponível para
              objetos.
            </p>
          )}
          <JsonBulkCodeEditor
            value={bulkText}
            onChange={handleBulkTextChange}
            defaultCollapsed={defaultJsonCollapsed}
          />
          {bulkError ? (
            <span className="text-[10px] text-red-500">{bulkError}</span>
          ) : null}
        </div>
      ) : (
        <JsonBodyRowsTable
          rows={rows}
          mode="object"
          collapsedIds={collapsedIds}
          onToggleCollapsed={toggleCollapsedId}
          onChange={commitRows}
        />
      )}
    </div>
  );
}

function JsonBodyViewer({
  value,
  defaultBodyMode = "table",
  defaultJsonCollapsed = false,
}: {
  value: unknown;
  defaultBodyMode?: DisplayBodyMode;
  defaultJsonCollapsed?: boolean;
}) {
  const hasBody = value != null && value !== "";
  const rootIsObject = isJsonObjectRoot(value);
  const [bulkOpen, setBulkOpen] = useState(
    () =>
      (value != null && value !== "" && !isJsonObjectRoot(value)) ||
      defaultBodyMode === "bulk",
  );
  // objectToJsonBodyRows gera ids novos a cada chamada — memoiza para o
  // colapso (collapsedIds) continuar batendo com as rows após o toggle.
  const rows = useMemo(
    () =>
      rootIsObject
        ? stripBlankJsonBodyRows(objectToJsonBodyRows(value))
        : [],
    [rootIsObject, value],
  );
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() =>
    defaultJsonCollapsed
      ? new Set(collectCompositeJsonBodyRowIds(rows))
      : new Set(),
  );

  useEffect(() => {
    if (hasBody && !rootIsObject) {
      setBulkOpen(true);
      return;
    }
    if (!hasBody) {
      setBulkOpen(false);
      return;
    }
    setBulkOpen(defaultBodyMode === "bulk");
  }, [hasBody, rootIsObject, value, defaultBodyMode]);

  useEffect(() => {
    setCollapsedIds(
      defaultJsonCollapsed
        ? new Set(collectCompositeJsonBodyRowIds(rows))
        : new Set(),
    );
  }, [rows, defaultJsonCollapsed]);

  function toggleCollapsedId(id: string) {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const showBulk = bulkOpen || (hasBody && !rootIsObject);
  const emptyTable = (
    <div className="flex max-h-60 flex-col overflow-hidden rounded border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-950">
      <div className="shrink-0 bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-100">
        <table className="min-w-full table-fixed border-separate border-spacing-0 text-[11px]">
          <colgroup>
            <col className="w-[40%]" />
            <col className="w-24" />
            <col />
            <col className="w-7" />
          </colgroup>
          <thead>
            <tr>
              <th className={tableHeadCellClass()}>Chave</th>
              <th className={tableHeadCellClass()}>Tipo</th>
              <th className={tableHeadCellClass()}>Valor</th>
              <th className={cn(tableHeadCellClass(), "px-1")} />
            </tr>
          </thead>
        </table>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="min-w-full table-fixed border-separate border-spacing-0 text-[11px]">
          <colgroup>
            <col className="w-[40%]" />
            <col className="w-24" />
            <col />
            <col className="w-7" />
          </colgroup>
          <tbody>
            <tr className={tableRowZebraClass(0)}>
              <td
                colSpan={4}
                className="border-b border-zinc-100 px-2 py-1 text-zinc-500 dark:border-zinc-800 dark:text-zinc-400"
              >
                {hasBody ? "{ }" : "(sem body)"}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-5 items-center justify-between gap-2">
        <span className="text-[12px] font-semibold leading-none text-zinc-800 dark:text-zinc-100">
          Body
        </span>
        {!hasBody || rootIsObject ? (
          <button
            type="button"
            className="text-[10px] font-medium text-zinc-500 underline-offset-2 hover:text-zinc-800 hover:underline dark:text-zinc-400 dark:hover:text-zinc-200"
            onClick={() => setBulkOpen((open) => !open)}
          >
            {bulkOpen ? "Table" : "Bulk"}
          </button>
        ) : null}
      </div>
      {showBulk ? (
        <JsonBulkCodeEditor
          value={hasBody ? formatJsonBody(value) : "null"}
          readOnly
          defaultCollapsed={defaultJsonCollapsed}
        />
      ) : !hasBody || rows.length === 0 ? (
        emptyTable
      ) : (
        <JsonBodyRowsTable
          rows={rows}
          mode="object"
          collapsedIds={collapsedIds}
          onToggleCollapsed={toggleCollapsedId}
          onChange={() => {}}
          readOnly
        />
      )}
    </div>
  );
}

function toStringRecord(value: unknown): Record<string, string | string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const input = value as Record<string, unknown>;
  const out: Record<string, string | string[]> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (Array.isArray(raw)) {
      out[key] = raw.map((item) => String(item));
    } else if (raw == null) {
      out[key] = "";
    } else {
      out[key] = String(raw);
    }
  }
  return out;
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function normalizeServerName(value: string): string {
  return value.trim().toLowerCase();
}

function getServerFromPathname(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "server" && parts[1]) {
    return normalizeServerName(decodeURIComponent(parts[1]));
  }
  return "";
}

function buildServerPath(serverName: string): string {
  return `/server/${encodeURIComponent(serverName)}`;
}

type InitialSession = {
  authenticated: boolean;
  serverName: string;
} | null;

export function HomeClient({ initialSession }: { initialSession: InitialSession }) {
  // Session state is initialized from server-side props (SSR reads the cookie),
  // so sessionReady starts as true — no loading screen on hard reloads.
  const [sessionReady, setSessionReady] = useState(true);
  const [authenticated, setAuthenticated] = useState(initialSession?.authenticated ?? false);
  const [currentServerName, setCurrentServerName] = useState(initialSession?.serverName ?? "");
  const [loginServerName, setLoginServerName] = useState(initialSession?.serverName ?? "");
  const [baseUrl, setBaseUrl] = useState(
    process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:8001",
  );
  const [loginPassword, setLoginPassword] = useState("");
  const [loginSubmitting, setLoginSubmitting] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [urlCopied, setUrlCopied] = useState(false);

  // API selection
  const [selectedApi, setSelectedApi] = useState("");
  const [apiList, setApiList] = useState<ApiConfig[]>([]);
  /** Contagem de requests em APIs não selecionadas — só na sessão atual. */
  const [unreadByApi, setUnreadByApi] = useState<Record<string, number>>({});
  const [draggingApi, setDraggingApi] = useState<string | null>(null);
  /** Índice de inserção durante o drag (0 = antes do 1º, length = depois do último). */
  const [dropInsertIndex, setDropInsertIndex] = useState<number | null>(null);
  const [dragGhost, setDragGhost] = useState<{
    apiName: string;
    width: number;
    height: number;
    left: number;
    top: number;
    selected: boolean;
    proxyToClient: boolean;
    proxyMode: boolean;
    unread: number;
  } | null>(null);
  const draggingApiRef = useRef<string | null>(null);
  const dropInsertIndexRef = useRef<number | null>(null);
  const dragGhostRef = useRef<HTMLDivElement | null>(null);
  const dragGhostOffsetRef = useRef({ x: 0, y: 0 });
  const [newApiName, setNewApiName] = useState("");
  const [showNewApiInput, setShowNewApiInput] = useState(false);
  const [deleteApiName, setDeleteApiName] = useState<string | null>(null);
  const [deleteRouteTarget, setDeleteRouteTarget] = useState<ApiRouteStat | null>(null);
  const [clearRequestsOpen, setClearRequestsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsHasPassword, setSettingsHasPassword] = useState(false);
  const [settingsCurrentPassword, setSettingsCurrentPassword] = useState("");
  const [settingsNewPassword, setSettingsNewPassword] = useState("");
  const [settingsConfirmPassword, setSettingsConfirmPassword] = useState("");
  const [settingsPasswordMessage, setSettingsPasswordMessage] = useState<string | null>(null);
  const [settingsPasswordSaving, setSettingsPasswordSaving] = useState(false);
  const [settingsDeleteConfirm, setSettingsDeleteConfirm] = useState("");
  const [settingsDeleteError, setSettingsDeleteError] = useState<string | null>(null);
  const [settingsDeleting, setSettingsDeleting] = useState(false);
  const [displayBodyMode, setDisplayBodyMode] =
    useState<DisplayBodyMode>("bulk");
  const [displayJsonCollapsed, setDisplayJsonCollapsed] = useState(true);
  const [displaySettingsSaving, setDisplaySettingsSaving] = useState(false);
  const [apiConfigOpen, setApiConfigOpen] = useState(false);
  const [apiProxyModeType, setApiProxyModeType] = useState<ProxyModeType>("disabled");
  const [apiProxyUrl, setApiProxyUrl] = useState("");
  const [apiProxyClientId, setApiProxyClientId] = useState("");
  const [apiProxyServiceName, setApiProxyServiceName] = useState("");
  const [apiConfigMessage, setApiConfigMessage] = useState<string | null>(null);
  const [apiConfigSaving, setApiConfigSaving] = useState(false);

  const [logs, setLogs] = useState<ApiRequestLog[]>([]);
  const [logsPage, setLogsPage] = useState(1);
  const [routes, setRoutes] = useState<ApiRouteStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<"requests" | "routes">("requests");
  const [configRouteId, setConfigRouteId] = useState<string | null>(null);
  const [configStatus, setConfigStatus] = useState<string>("200");
  const [configBody, setConfigBody] = useState<string>('{"status":"ok"}');
  const [configHeaders, setConfigHeaders] = useState<string>("{}");
  const [configProxyUrl, setConfigProxyUrl] = useState("");
  // null = sem override de rota (usa proxy da API quando ela tem proxy configurado)
  const [configProxyModeType, setConfigProxyModeType] = useState<ProxyModeType | null>("disabled");
  const [configProxyClientId, setConfigProxyClientId] = useState("");
  const [configProxyServiceName, setConfigProxyServiceName] = useState("");
  const [connectedClients, setConnectedClients] = useState<ProxyClientInfo[]>([]);
  const [configMessage, setConfigMessage] = useState<string | null>(null);
  const [dynamicRules, setDynamicRules] = useState<DynamicMockRule[]>([]);
  const [expandedDynamicRuleIds, setExpandedDynamicRuleIds] = useState<string[]>([]);
  const [draftDynamicRuleIds, setDraftDynamicRuleIds] = useState<string[]>([]);
  const [draggingRuleId, setDraggingRuleId] = useState<string | null>(null);
  const [ruleDropIndex, setRuleDropIndex] = useState<number | null>(null);
  const dynamicRulesRef = useRef<DynamicMockRule[]>([]);
  const draggingRuleIdRef = useRef<string | null>(null);
  const ruleDropIndexRef = useRef<number | null>(null);
  const [showAddRouteForm, setShowAddRouteForm] = useState(false);
  const [newRouteMethod, setNewRouteMethod] = useState("GET");
  const [newRoutePath, setNewRoutePath] = useState("/");
  const [newRouteError, setNewRouteError] = useState<string | null>(null);
  const [newRouteSaving, setNewRouteSaving] = useState(false);
  const [wildcardModal, setWildcardModal] = useState<{
    route: ApiRouteStat;
    newPath: string;
    affectedRoutes: ApiRouteStat[];
  } | null>(null);
  const [wildcardConverting, setWildcardConverting] = useState(false);
  const [paramNameModal, setParamNameModal] = useState<{
    route: ApiRouteStat;
    segIndex: number;
    segments: string[];
    paramName: string;
    error: string | null;
  } | null>(null);
  const [editingWildcardSegment, setEditingWildcardSegment] = useState<{
    routeId: string;
    segIndex: number;
    value: string;
  } | null>(null);
  const [segmentEditSaving, setSegmentEditSaving] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importFileName, setImportFileName] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importDetected, setImportDetected] = useState<DetectedImport | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("freeceptor");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const sseRef = useRef<EventSource | null>(null);
  const hasLoadedOnce = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Initialize from server session so the ref is correct from the start.
  const authenticatedRef = useRef(initialSession?.authenticated ?? false);
  // Tracks the previous selectedApi to detect real API switches (vs. initial mount).
  const prevSelectedApiRef = useRef<string | null>(null);
  const selectedApiRef = useRef(selectedApi);
  const apiListRef = useRef(apiList);
  const apiStripRef = useRef<HTMLDivElement | null>(null);
  const apiDragMovedRef = useRef(false);

  useEffect(() => {
    selectedApiRef.current = selectedApi;
  }, [selectedApi]);

  useEffect(() => {
    apiListRef.current = apiList;
  }, [apiList]);

  useEffect(() => {
    dynamicRulesRef.current = dynamicRules;
  }, [dynamicRules]);

  // Restore UI state (selected API + active tab + open route config form) from
  // sessionStorage synchronously before the browser paints so the user doesn't
  // lose their place on HMR reloads.
  useLayoutEffect(() => {
    try {
      const api = sessionStorage.getItem("fc_selected_api");
      const tab = sessionStorage.getItem("fc_active_tab");
      if (api) setSelectedApi(api);
      if (tab === "routes") setActiveTab("routes");

      const configStateStr = sessionStorage.getItem("fc_config_state");
      if (configStateStr) {
        const cs = JSON.parse(configStateStr) as {
          configRouteId?: string;
          configStatus?: string;
          configBody?: string;
          configHeaders?: string;
          // null is a valid persisted value (= no route override, use API proxy)
          configProxyModeType?: ProxyModeType | null;
          configProxyUrl?: string;
          configProxyClientId?: string;
          configProxyServiceName?: string;
        };
        if (cs.configRouteId) setConfigRouteId(cs.configRouteId);
        if (cs.configStatus) setConfigStatus(cs.configStatus);
        if (cs.configBody !== undefined) setConfigBody(cs.configBody);
        if (cs.configHeaders !== undefined) setConfigHeaders(cs.configHeaders);
        // Restore even when null (null is a meaningful state)
        if ("configProxyModeType" in cs) {
          const restored = cs.configProxyModeType ?? null;
          // Legacy session value "dynamic" → unified mock mode
          setConfigProxyModeType(
            (restored as string) === "dynamic"
              ? "disabled"
              : (restored as ProxyModeType | null),
          );
        }
        if (cs.configProxyUrl !== undefined) setConfigProxyUrl(cs.configProxyUrl);
        if (cs.configProxyClientId !== undefined) setConfigProxyClientId(cs.configProxyClientId);
        if (cs.configProxyServiceName !== undefined) setConfigProxyServiceName(cs.configProxyServiceName);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_BASE_URL) {
      setBaseUrl(window.location.origin);
    }
  }, []);

  // Diagnóstico: captura o que está causando o reload da página
  useEffect(() => {
    // Mostra o diagnóstico do reload anterior (se existir)
    try {
      const prev = sessionStorage.getItem("fc_debug_unload");
      if (prev) {
        console.warn("[FC-DEBUG] ℹ️ Reload anterior registrado:", JSON.parse(prev));
        sessionStorage.removeItem("fc_debug_unload");
      }
    } catch { /* ignore */ }

    const origPushState = history.pushState.bind(history);
    const origReplaceState = history.replaceState.bind(history);

    history.pushState = function (...args: Parameters<typeof history.pushState>) {
      console.warn("[FC-DEBUG] history.pushState chamado →", args[2]);
      console.trace("[FC-DEBUG] pushState stack:");
      return origPushState(...args);
    };

    history.replaceState = function (...args: Parameters<typeof history.replaceState>) {
      const url = args[2];
      console.warn("[FC-DEBUG] history.replaceState chamado →", url);
      console.trace("[FC-DEBUG] replaceState stack:");
      return origReplaceState(...args);
    };

    const onBeforeUnload = () => {
      console.error("[FC-DEBUG] ⚠️ PÁGINA SENDO DESCARREGADA");
      // Persiste no sessionStorage para ver depois do reload
      try {
        sessionStorage.setItem("fc_debug_unload", JSON.stringify({
          time: new Date().toISOString(),
          url: window.location.href,
          msg: "beforeunload disparado — verifique o console com 'Preserve log' ativado",
        }));
      } catch { /* ignore */ }
    };

    const onPopState = (e: PopStateEvent) => {
      console.warn("[FC-DEBUG] popstate disparado →", e.state, window.location.href);
      console.trace("[FC-DEBUG] popstate stack:");
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("popstate", onPopState);

    return () => {
      history.pushState = origPushState;
      history.replaceState = origReplaceState;
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("popstate", onPopState);
    };
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    try {
      if (selectedApi) {
        sessionStorage.setItem("fc_selected_api", selectedApi);
      } else {
        sessionStorage.removeItem("fc_selected_api");
      }
      // Clear persisted route config state when API changes —
      // route IDs belong to the previous API and would be stale.
      sessionStorage.removeItem("fc_config_state");
    } catch { /* ignore */ }
  }, [authenticated, selectedApi]);

  useEffect(() => {
    if (!authenticated) return;
    try {
      sessionStorage.setItem("fc_active_tab", activeTab);
    } catch { /* ignore */ }
  }, [authenticated, activeTab]);

  // Persists the open route config form state so the user doesn't lose
  // unsaved work when HMR triggers a component remount.
  useEffect(() => {
    if (!authenticated) return;
    try {
      if (!configRouteId) {
        sessionStorage.removeItem("fc_config_state");
      } else {
        sessionStorage.setItem(
          "fc_config_state",
          JSON.stringify({
            configRouteId,
            configStatus,
            configBody,
            configHeaders,
            configProxyModeType,
            configProxyUrl,
            configProxyClientId,
            configProxyServiceName,
          }),
        );
      }
    } catch { /* ignore */ }
  }, [
    authenticated,
    configRouteId,
    configStatus,
    configBody,
    configHeaders,
    configProxyModeType,
    configProxyUrl,
    configProxyClientId,
    configProxyServiceName,
  ]);

  function toggleLogExpanded(id: string) {
    setExpandedIds((prev) =>
      prev.includes(id) ? prev.filter((logId) => logId !== id) : [...prev, id],
    );
  }

  async function loadApiList() {
    try {
      const res = await fetch("/api/apis");
      if (!res.ok) return;
      const apis = (await res.json()) as ApiConfig[];
      setApiList(apis);
      // Auto-select first API when none is selected
      setSelectedApi((prev) => (!prev && apis.length > 0 ? apis[0].apiName : prev));
    } catch {
      // non-fatal
    }
  }

  function selectApi(apiName: string) {
    setSelectedApi(apiName);
    setUnreadByApi((prev) => {
      const key = apiName.toLowerCase();
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function getApiInsertIndexFromX(clientX: number): number {
    const strip = apiStripRef.current;
    const list = apiListRef.current;
    if (!strip || list.length === 0) return 0;

    for (let i = 0; i < list.length; i++) {
      const el = strip.querySelector<HTMLElement>(
        `[data-api-chip="${CSS.escape(list[i].apiName)}"]`,
      );
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return i;
    }
    return list.length;
  }

  async function reorderApisToIndex(fromName: string, insertIndex: number) {
    const list = apiListRef.current;
    const fromIndex = list.findIndex((a) => a.apiName === fromName);
    if (fromIndex < 0) return;

    // Mesma posição: soltar à esquerda ou à direita de si mesmo.
    if (insertIndex === fromIndex || insertIndex === fromIndex + 1) return;

    const next = [...list];
    const [moved] = next.splice(fromIndex, 1);
    let adjusted = insertIndex;
    if (fromIndex < insertIndex) adjusted -= 1;
    adjusted = Math.max(0, Math.min(adjusted, next.length));
    next.splice(adjusted, 0, moved);
    setApiList(next);

    try {
      const res = await fetch("/api/apis", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: next.map((a) => a.apiName) }),
      });
      if (res.ok) {
        const apis = (await res.json()) as ApiConfig[];
        setApiList(apis);
      } else {
        await loadApiList();
      }
    } catch {
      await loadApiList();
    }
  }

  function positionApiDragGhost(clientX: number, clientY: number) {
    const el = dragGhostRef.current;
    if (!el) return;
    const { x: ox, y: oy } = dragGhostOffsetRef.current;
    el.style.transform = `translate3d(${clientX - ox}px, ${clientY - oy}px, 0)`;
  }

  function beginApiChipDrag(
    event: React.PointerEvent<HTMLElement>,
    apiName: string,
  ) {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest("[data-api-delete]")) return;

    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const chipRect = event.currentTarget.getBoundingClientRect();
    let dragging = false;

    const updateIndicator = (clientX: number) => {
      const insertAt = getApiInsertIndexFromX(clientX);
      dropInsertIndexRef.current = insertAt;
      setDropInsertIndex((prev) => (prev === insertAt ? prev : insertAt));
    };

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const dist = Math.hypot(ev.clientX - startX, ev.clientY - startY);
      if (!dragging) {
        if (dist < 5) return;
        dragging = true;
        apiDragMovedRef.current = true;
        draggingApiRef.current = apiName;
        const offset = {
          x: startX - chipRect.left,
          y: startY - chipRect.top,
        };
        dragGhostOffsetRef.current = offset;
        const api = apiListRef.current.find((a) => a.apiName === apiName);
        setDraggingApi(apiName);
        setDragGhost({
          apiName,
          width: chipRect.width,
          height: chipRect.height,
          left: ev.clientX - offset.x,
          top: ev.clientY - offset.y,
          selected: selectedApiRef.current === apiName,
          proxyToClient: Boolean(api?.proxyToClient),
          proxyMode: Boolean(api?.proxyMode),
          unread: unreadByApi[apiName.toLowerCase()] ?? 0,
        });
        requestAnimationFrame(() => {
          positionApiDragGhost(ev.clientX, ev.clientY);
        });
      }
      ev.preventDefault();
      positionApiDragGhost(ev.clientX, ev.clientY);
      updateIndicator(ev.clientX);
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);

      if (!dragging) {
        selectApi(apiName);
        return;
      }

      const insertAt =
        dropInsertIndexRef.current ?? getApiInsertIndexFromX(ev.clientX);
      const from = draggingApiRef.current;
      draggingApiRef.current = null;
      dropInsertIndexRef.current = null;
      setDraggingApi(null);
      setDropInsertIndex(null);
      setDragGhost(null);
      if (from) {
        void reorderApisToIndex(from, insertAt);
      }

      // Evita click fantasma após o drag.
      window.setTimeout(() => {
        apiDragMovedRef.current = false;
      }, 0);
    };

    apiDragMovedRef.current = false;
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  function getDynamicRuleInsertIndex(clientY: number): number {
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>("[data-dynamic-rule]"),
    );
    for (let i = 0; i < rows.length; i++) {
      const rect = rows[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return rows.length;
  }

  function beginDynamicRuleDrag(
    event: React.PointerEvent<HTMLElement>,
    ruleId: string,
  ) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const pointerId = event.pointerId;
    const startY = event.clientY;
    let dragging = false;
    const fromIndex = dynamicRulesRef.current.findIndex((r) => r.id === ruleId);
    if (fromIndex < 0) return;

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!dragging) {
        if (Math.abs(ev.clientY - startY) < 5) return;
        dragging = true;
        draggingRuleIdRef.current = ruleId;
        setDraggingRuleId(ruleId);
      }
      ev.preventDefault();
      const insertAt = getDynamicRuleInsertIndex(ev.clientY);
      ruleDropIndexRef.current = insertAt;
      setRuleDropIndex((prev) => (prev === insertAt ? prev : insertAt));
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);

      if (!dragging) return;

      const insertAt =
        ruleDropIndexRef.current ?? getDynamicRuleInsertIndex(ev.clientY);
      const list = [...dynamicRulesRef.current];
      const from = list.findIndex((r) => r.id === ruleId);
      draggingRuleIdRef.current = null;
      ruleDropIndexRef.current = null;
      setDraggingRuleId(null);
      setRuleDropIndex(null);

      if (from < 0) return;
      if (insertAt === from || insertAt === from + 1) return;

      const [moved] = list.splice(from, 1);
      let adjusted = insertAt;
      if (from < insertAt) adjusted -= 1;
      adjusted = Math.max(0, Math.min(adjusted, list.length));
      list.splice(adjusted, 0, moved);
      setDynamicRules(list);
    };

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  function clearLocalSession() {
    authenticatedRef.current = false;
    try {
      sessionStorage.removeItem("fc_auth");
      sessionStorage.removeItem("fc_server");
      sessionStorage.removeItem("fc_selected_api");
      sessionStorage.removeItem("fc_active_tab");
      sessionStorage.removeItem("fc_config_state");
    } catch {
      // ignore
    }
    hasLoadedOnce.current = false;
    setAuthenticated(false);
    setCurrentServerName("");
    setSelectedApi("");
    setApiList([]);
    setLogs([]);
    setRoutes([]);
    setUnreadByApi({});
    sseRef.current?.close();
  }

  function applyDisplaySettings(data: {
    displayBodyMode?: unknown;
    displayJsonCollapsed?: unknown;
  }) {
    if (data.displayBodyMode === "bulk" || data.displayBodyMode === "table") {
      setDisplayBodyMode(data.displayBodyMode);
    }
    if (typeof data.displayJsonCollapsed === "boolean") {
      setDisplayJsonCollapsed(data.displayJsonCollapsed);
    }
  }

  async function loadDisplaySettings() {
    try {
      const res = await fetch("/api/server/settings");
      if (!res.ok) return;
      const data = (await res.json()) as {
        hasPassword?: boolean;
        displayBodyMode?: DisplayBodyMode;
        displayJsonCollapsed?: boolean;
      };
      setSettingsHasPassword(Boolean(data.hasPassword));
      applyDisplaySettings(data);
    } catch {
      // ignore
    }
  }

  async function openSettings() {
    setSettingsOpen(true);
    setSettingsCurrentPassword("");
    setSettingsNewPassword("");
    setSettingsConfirmPassword("");
    setSettingsPasswordMessage(null);
    setSettingsDeleteConfirm("");
    setSettingsDeleteError(null);
    await loadDisplaySettings();
  }

  async function saveDisplaySettings(patch: {
    displayBodyMode?: DisplayBodyMode;
    displayJsonCollapsed?: boolean;
  }) {
    if (
      (patch.displayBodyMode === undefined ||
        patch.displayBodyMode === displayBodyMode) &&
      (patch.displayJsonCollapsed === undefined ||
        patch.displayJsonCollapsed === displayJsonCollapsed)
    ) {
      return;
    }
    const prevMode = displayBodyMode;
    const prevCollapsed = displayJsonCollapsed;
    applyDisplaySettings(patch);
    setDisplaySettingsSaving(true);
    try {
      const res = await fetch("/api/server/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        setDisplayBodyMode(prevMode);
        setDisplayJsonCollapsed(prevCollapsed);
        return;
      }
      const data = (await res.json().catch(() => null)) as {
        displayBodyMode?: DisplayBodyMode;
        displayJsonCollapsed?: boolean;
      } | null;
      if (data) applyDisplaySettings(data);
    } catch {
      setDisplayBodyMode(prevMode);
      setDisplayJsonCollapsed(prevCollapsed);
    } finally {
      setDisplaySettingsSaving(false);
    }
  }

  async function saveServerPassword(remove: boolean) {
    setSettingsPasswordMessage(null);
    if (!remove) {
      if (settingsNewPassword !== settingsConfirmPassword) {
        setSettingsPasswordMessage("A confirmação não confere com a nova senha.");
        return;
      }
    }
    setSettingsPasswordSaving(true);
    try {
      const res = await fetch("/api/server/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: settingsHasPassword
            ? settingsCurrentPassword
            : undefined,
          password: remove ? "" : settingsNewPassword,
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: string;
        hasPassword?: boolean;
      } | null;
      if (!res.ok) {
        setSettingsPasswordMessage(data?.error ?? "Falha ao atualizar senha.");
        return;
      }
      setSettingsHasPassword(Boolean(data?.hasPassword));
      setSettingsCurrentPassword("");
      setSettingsNewPassword("");
      setSettingsConfirmPassword("");
      setSettingsPasswordMessage(
        data?.hasPassword ? "Senha atualizada." : "Senha removida.",
      );
    } catch {
      setSettingsPasswordMessage("Falha ao atualizar senha.");
    } finally {
      setSettingsPasswordSaving(false);
    }
  }

  async function confirmDeleteServer() {
    setSettingsDeleteError(null);
    if (
      settingsDeleteConfirm.trim().toLowerCase() !==
      currentServerName.trim().toLowerCase()
    ) {
      setSettingsDeleteError("Digite o nome do servidor exatamente para confirmar.");
      return;
    }
    setSettingsDeleting(true);
    try {
      const res = await fetch("/api/server/settings", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmName: settingsDeleteConfirm.trim() }),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok) {
        setSettingsDeleteError(data?.error ?? "Falha ao deletar servidor.");
        return;
      }
      setSettingsOpen(false);
      clearLocalSession();
    } catch {
      setSettingsDeleteError("Falha ao deletar servidor.");
    } finally {
      setSettingsDeleting(false);
    }
  }

  async function confirmDeleteApi() {
    if (!deleteApiName) return;
    try {
      await fetch(`/api/apis?apiName=${encodeURIComponent(deleteApiName)}`, {
        method: "DELETE",
      });
      setDeleteApiName(null);
      const wasSelected = selectedApi === deleteApiName;
      setUnreadByApi((prev) => {
        const key = deleteApiName.toLowerCase();
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      if (wasSelected) setSelectedApi("");
      await loadApiList();
      // If was selected and there are no more APIs, reset loading state
      if (wasSelected) {
        setLogs([]);
        setRoutes([]);
        setLoading(false);
        hasLoadedOnce.current = false;
      }
    } catch {
      // non-fatal
    }
  }

  async function confirmDeleteRoute() {
    if (!deleteRouteTarget) return;
    const route = deleteRouteTarget;
    setDeleteRouteTarget(null);
    setRoutes((prev) => prev.filter((r) => r.id !== route.id));
    if (configRouteId === route.id) setConfigRouteId(null);
    try {
      await fetch("/api/routes", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiName: selectedApi,
          method: route.method,
          path: route.path,
        }),
      });
    } catch (err) {
      console.error("Erro ao deletar rota:", err);
      setRoutes((prev) =>
        [...prev, route].sort((a, b) =>
          a.path === b.path
            ? a.method.localeCompare(b.method)
            : a.path.localeCompare(b.path),
        ),
      );
    }
  }

  async function confirmClearRequests() {
    try {
      await fetch(`/api/logs?apiName=${encodeURIComponent(selectedApi)}`, {
        method: "DELETE",
      });
      setLogs([]);
      setExpandedIds([]);
      setClearRequestsOpen(false);
    } catch (err) {
      console.error("Erro ao limpar requisições:", err);
    }
  }

  function copyUrl() {
    const url = `${baseUrl}/api/${currentServerName}/${selectedApi}/*`;
    navigator.clipboard.writeText(url).then(() => {
      setUrlCopied(true);
      setTimeout(() => setUrlCopied(false), 2000);
    }).catch(() => {/* ignore */});
  }

  async function openRouteConfig(route: ApiRouteStat) {
    const isSame = configRouteId === route.id;
    if (isSame) {
      setConfigRouteId(null);
      setConfigMessage(null);
      return;
    }

    setConfigRouteId(route.id);
    setConfigMessage(null);
    setConfigStatus("200");
    setConfigBody('{"status":"ok"}');
    setConfigHeaders("{}");
    setConfigProxyUrl("");
    // When the API has a proxy, default to null (no route-level override = inherit API proxy).
    // When there's no API proxy, default to "disabled" (mock).
    setConfigProxyModeType(apiHasProxy ? null : "disabled");
    setConfigProxyClientId("");
    setConfigProxyServiceName("");
    setDynamicRules([]);
    setExpandedDynamicRuleIds([]);
    setDraftDynamicRuleIds([]);

    try {
      const res = await fetch(`/api/routes/configs?apiName=${encodeURIComponent(selectedApi)}`);
      if (!res.ok) throw new Error(await res.text());
      const configs = (await res.json()) as ApiRouteConfig[];
      const match = configs.find(
        (cfg) =>
          cfg.method.toUpperCase() === route.method.toUpperCase() &&
          normalizePathFront(cfg.path) === normalizePathFront(route.path),
      );
      if (match) {
        setConfigStatus(String(match.status ?? 200));
        setConfigBody(
          match.body !== undefined && match.body !== null
            ? JSON.stringify(match.body, null, 2)
            : '{"status":"ok"}',
        );
        setConfigHeaders(
          match.headers && Object.keys(match.headers).length
            ? JSON.stringify(match.headers, null, 2)
            : "{}",
        );
        if (match.proxyToClient && match.proxyClientId) {
          setConfigProxyModeType("client");
          setConfigProxyClientId(match.proxyClientId);
          setConfigProxyServiceName(match.proxyServiceName ?? "");
        } else if (match.proxyMode && match.proxyUrl) {
          setConfigProxyModeType("url");
          setConfigProxyUrl(match.proxyUrl);
        } else if (match.explicitlyConfigured) {
          setConfigProxyModeType("disabled");
          const rules = normalizeDynamicRules(match.dynamicRules);
          setDynamicRules(rules);
          setExpandedDynamicRuleIds(rules[0] ? [rules[0].id] : []);
          setDraftDynamicRuleIds([]);
        } else {
          setConfigProxyModeType(apiHasProxy ? null : "disabled");
          setDynamicRules([]);
          setExpandedDynamicRuleIds([]);
          setDraftDynamicRuleIds([]);
        }
      }
    } catch (err) {
      console.error("Erro ao carregar config da rota:", err);
    }
  }

  async function convertToWildcard(
    sourceRoute: ApiRouteStat,
    newPath: string,
    affectedRoutes: ApiRouteStat[],
  ) {
    setWildcardConverting(true);
    try {
      let config: ApiRouteConfig = {
        apiName: selectedApi,
        method: sourceRoute.method,
        path: sourceRoute.path,
        status: 200,
        body: { status: "ok" },
        headers: {},
        proxyMode: false,
        proxyUrl: "",
        proxyToClient: false,
        proxyClientId: "",
        proxyServiceName: "",
        explicitlyConfigured: false,
        mockMode: "dynamic",
        dynamicRules: [],
      };

      const configsRes = await fetch(
        `/api/routes/configs?apiName=${encodeURIComponent(selectedApi)}`,
      );
      if (configsRes.ok) {
        const configs = (await configsRes.json()) as ApiRouteConfig[];
        const match = configs.find(
          (cfg) =>
            cfg.method.toUpperCase() === sourceRoute.method.toUpperCase() &&
            normalizePathFront(cfg.path) === normalizePathFront(sourceRoute.path),
        );
        if (match) config = match;
      }

      const apiCfg = apiList.find(
        (a) => a.apiName.toLowerCase() === selectedApi.toLowerCase(),
      );
      const apiUsesProxy = Boolean(
        apiCfg &&
          ((apiCfg.proxyMode && apiCfg.proxyUrl) ||
            (apiCfg.proxyToClient &&
              apiCfg.proxyClientId &&
              apiCfg.proxyServiceName)),
      );
      const sourceHasRouteProxy = Boolean(
        (config.proxyMode && config.proxyUrl) ||
          (config.proxyToClient &&
            config.proxyClientId &&
            config.proxyServiceName),
      );
      const inheritApiProxy = apiUsesProxy && !sourceHasRouteProxy;

      const postRes = await fetch("/api/routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiName: selectedApi,
          method: sourceRoute.method,
          path: newPath,
          status: config.status ?? 200,
          headers: config.headers ?? {},
          responseBody: config.body ?? { status: "ok" },
          proxyMode: inheritApiProxy ? false : (config.proxyMode ?? false),
          proxyUrl: inheritApiProxy ? "" : (config.proxyUrl ?? ""),
          proxyToClient: inheritApiProxy ? false : (config.proxyToClient ?? false),
          proxyClientId: inheritApiProxy ? "" : (config.proxyClientId ?? ""),
          proxyServiceName: inheritApiProxy ? "" : (config.proxyServiceName ?? ""),
          explicitlyConfigured: inheritApiProxy
            ? false
            : sourceHasRouteProxy ||
              Boolean(config.explicitlyConfigured) ||
              !apiUsesProxy,
          mockMode: "dynamic",
          dynamicRules: config.dynamicRules ?? [],
        }),
      });
      if (!postRes.ok) throw new Error(await postRes.text());

      const toDelete = [sourceRoute, ...affectedRoutes];
      await Promise.all(
        toDelete.map((r) =>
          fetch("/api/routes", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              apiName: selectedApi,
              method: r.method,
              path: r.path,
            }),
          }),
        ),
      );

      if (configRouteId === sourceRoute.id) setConfigRouteId(null);
      setWildcardModal(null);

      const routesRes = await fetch(
        `/api/routes?apiName=${encodeURIComponent(selectedApi)}`,
      );
      if (routesRes.ok) {
        setRoutes((await routesRes.json()) as ApiRouteStat[]);
      }
    } catch (err) {
      console.error("Erro ao converter para parâmetro:", err);
    } finally {
      setWildcardConverting(false);
    }
  }

  async function confirmParamNameModal() {
    if (!paramNameModal) return;
    const name = paramNameModal.paramName.trim();
    if (!isValidParamName(name)) {
      setParamNameModal({
        ...paramNameModal,
        error: "Use um nome válido (ex.: id, userId).",
      });
      return;
    }
    const { route, segIndex, segments } = paramNameModal;
    const otherNames = segments
      .map((s, i) => (i !== segIndex && s.startsWith(":") ? s.slice(1) : null))
      .filter(Boolean);
    if (otherNames.includes(name)) {
      setParamNameModal({
        ...paramNameModal,
        error: "Já existe um parâmetro com esse nome neste path.",
      });
      return;
    }

    const newSegments = [...segments];
    newSegments[segIndex] = `:${name}`;
    const newPath = `/${newSegments.join("/")}`;
    if (normalizePathFront(route.path) === normalizePathFront(newPath)) {
      setParamNameModal(null);
      return;
    }

    try {
      const params = new URLSearchParams({
        apiName: selectedApi,
        method: route.method,
        path: newPath,
        excludePath: route.path,
      });
      const res = await fetch(`/api/routes/wildcard-preview?${params}`);
      if (!res.ok) throw new Error(await res.text());
      const affected = (await res.json()) as ApiRouteStat[];
      setParamNameModal(null);
      setWildcardModal({ route, newPath, affectedRoutes: affected });
    } catch (err) {
      console.error("Erro ao preview parâmetro:", err);
      setParamNameModal({
        ...paramNameModal,
        error: "Não foi possível preparar o merge.",
      });
    }
  }

  function handleSegmentClick(
    route: ApiRouteStat,
    segIndex: number,
    segments: string[],
  ) {
    const seg = segments[segIndex];
    if (seg.startsWith(":") && seg.length > 1) return;

    // Legacy * → migrate to named param
    const suggested =
      seg === "*"
        ? `param${segments.filter((s, i) => i < segIndex && isPathParamSegmentFront(s)).length}`
        : "id";

    setParamNameModal({
      route,
      segIndex,
      segments,
      paramName: suggested,
      error: null,
    });
  }

  async function renameNamedPathParam(
    route: ApiRouteStat,
    segIndex: number,
    segments: string[],
    nextNameRaw: string,
  ) {
    const currentSeg = segments[segIndex] ?? "";
    if (!currentSeg.startsWith(":") || currentSeg.length < 2) return;

    const oldName = currentSeg.slice(1);
    let nextName = nextNameRaw.trim();
    if (nextName.startsWith(":")) nextName = nextName.slice(1).trim();

    if (!isValidParamName(nextName)) return;

    const otherNames = segments
      .map((s, i) => (i !== segIndex && s.startsWith(":") ? s.slice(1) : null))
      .filter(Boolean);
    if (otherNames.includes(nextName)) return;

    const newSegments = [...segments];
    newSegments[segIndex] = `:${nextName}`;
    const newPath = `/${newSegments.join("/")}`;

    if (normalizePathFront(route.path) === normalizePathFront(newPath)) {
      setEditingWildcardSegment(null);
      return;
    }

    setSegmentEditSaving(true);
    try {
      let config: ApiRouteConfig = {
        apiName: selectedApi,
        method: route.method,
        path: route.path,
        status: 200,
        body: { status: "ok" },
        headers: {},
        proxyMode: false,
        proxyUrl: "",
        proxyToClient: false,
        proxyClientId: "",
        proxyServiceName: "",
        explicitlyConfigured: false,
        mockMode: "dynamic",
        dynamicRules: [],
      };

      const configsRes = await fetch(
        `/api/routes/configs?apiName=${encodeURIComponent(selectedApi)}`,
      );
      if (configsRes.ok) {
        const configs = (await configsRes.json()) as ApiRouteConfig[];
        const match = configs.find(
          (cfg) =>
            cfg.method.toUpperCase() === route.method.toUpperCase() &&
            normalizePathFront(cfg.path) === normalizePathFront(route.path),
        );
        if (match) config = match;
      }

      const remappedRules = normalizeDynamicRules(config.dynamicRules).map(
        (rule) => ({
          ...rule,
          conditions: rule.conditions.map((condition) =>
            condition.source === "path" && condition.key === oldName
              ? { ...condition, key: nextName }
              : condition,
          ),
        }),
      );

      const postRes = await fetch("/api/routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiName: selectedApi,
          method: route.method,
          path: newPath,
          status: config.status ?? 200,
          headers: config.headers ?? {},
          responseBody: config.body ?? { status: "ok" },
          proxyMode: config.proxyMode ?? false,
          proxyUrl: config.proxyUrl ?? "",
          proxyToClient: config.proxyToClient ?? false,
          proxyClientId: config.proxyClientId ?? "",
          proxyServiceName: config.proxyServiceName ?? "",
          explicitlyConfigured: Boolean(config.explicitlyConfigured),
          mockMode: "dynamic",
          dynamicRules: remappedRules,
        }),
      });
      if (!postRes.ok) throw new Error(await postRes.text());

      await fetch("/api/routes", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiName: selectedApi,
          method: route.method,
          path: route.path,
        }),
      });

      if (configRouteId === route.id) {
        setConfigRouteId(null);
      }
      setEditingWildcardSegment(null);

      const routesRes = await fetch(
        `/api/routes?apiName=${encodeURIComponent(selectedApi)}`,
      );
      if (routesRes.ok) {
        setRoutes((await routesRes.json()) as ApiRouteStat[]);
      }
    } catch (err) {
      console.error("Erro ao renomear parâmetro do path:", err);
    } finally {
      setSegmentEditSaving(false);
    }
  }

  async function openApiConfig() {
    setApiConfigOpen(true);
    setApiConfigMessage(null);
    setApiProxyModeType("disabled");
    setApiProxyUrl("");
    setApiProxyClientId("");
    setApiProxyServiceName("");

    try {
      const res = await fetch("/api/apis");
      if (!res.ok) return;
      const apis = (await res.json()) as ApiConfig[];
      const match = apis.find(
        (a) => a.apiName.toLowerCase() === selectedApi.toLowerCase(),
      );
      if (match) {
        if (match.proxyToClient && match.proxyClientId) {
          setApiProxyModeType("client");
          setApiProxyClientId(match.proxyClientId);
          setApiProxyServiceName(match.proxyServiceName ?? "");
        } else if (match.proxyMode && match.proxyUrl) {
          setApiProxyModeType("url");
          setApiProxyUrl(match.proxyUrl);
        }
      }
    } catch {
      // non-fatal
    }
  }

  async function readImportFile(file: File) {
    const raw = await file.text();
    const parsed = parseFileContent(raw, file.name);
    setImportText(JSON.stringify(parsed, null, 2));
    setImportFileName(file.name);
    setImportDetected(analyzeImportFile(parsed, selectedApi));
  }

  async function persistRouteConfigs(configs: RouteConfigInput[]) {
    for (const cfg of configs) {
      if (!cfg.method || !cfg.path) {
        throw new Error("JSON inválido: cada item precisa de method e path.");
      }
      const res = await fetch("/api/routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiName: selectedApi,
          method: cfg.method,
          path: cfg.path,
          status: cfg.status,
          headers: cfg.headers ?? {},
          responseBody: cfg.body ?? null,
          proxyMode: Boolean(cfg.proxyMode),
          proxyUrl: cfg.proxyUrl ?? "",
          proxyToClient: Boolean(cfg.proxyToClient),
          proxyClientId: cfg.proxyClientId ?? "",
          proxyServiceName: cfg.proxyServiceName ?? "",
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Falha ao importar rota ${cfg.method} ${cfg.path}: ${text}`,
        );
      }
    }
  }

  async function handleExport() {
    try {
      setExportError(null);
      setExporting(true);
      const res = await fetch(
        `/api/routes/configs?apiName=${encodeURIComponent(selectedApi)}`,
      );
      if (!res.ok) throw new Error(await res.text());
      const configs = (await res.json()) as ApiRouteConfig[];
      const timestamp = exportTimestamp();

      if (exportFormat === "freeceptor") {
        downloadTextFile(
          JSON.stringify(configs, null, 2),
          `freeceptor-${selectedApi}-configs-${timestamp}.json`,
          "application/json",
        );
      } else {
        const openApiDoc = routeConfigsToOpenApi(configs, selectedApi);
        if (exportFormat === "openapi-json") {
          downloadTextFile(
            JSON.stringify(openApiDoc, null, 2),
            `${selectedApi}-openapi-${timestamp}.json`,
            "application/json",
          );
        } else {
          downloadTextFile(
            stringifyYaml(openApiDoc),
            `${selectedApi}-openapi-${timestamp}.yaml`,
            "application/x-yaml",
          );
        }
      }
      setExportOpen(false);
    } catch (err) {
      setExportError(
        err instanceof Error ? err.message : "Erro ao exportar configs.",
      );
    } finally {
      setExporting(false);
    }
  }

  // Connect SSE for current api (with auto-reconnect on error)
  function connectSse(api: string) {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    sseRef.current?.close();

    const es = new EventSource(`/api/events?apiName=${encodeURIComponent(api)}`);
    sseRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as {
          type?: string;
          apiName?: string;
          logs?: ApiRequestLog[];
          routes?: ApiRouteStat[];
          clients?: ProxyClientInfo[];
        };
        if (data.type === "heartbeat") return; // ignorar keepalive
        if (data.type === "api_activity" && data.apiName) {
          const activeApi = data.apiName.toLowerCase();
          if (activeApi !== selectedApiRef.current.toLowerCase()) {
            setUnreadByApi((prev) => ({
              ...prev,
              [activeApi]: (prev[activeApi] ?? 0) + 1,
            }));
          }
          return;
        }
        if (data.logs) setLogs(data.logs);
        if (data.routes) setRoutes(data.routes);
        if (data.clients) setConnectedClients(data.clients);
        if (data.logs || data.routes) setLoading(false);
      } catch {
        // ignore
      }
    };

    es.onerror = () => {
      console.warn("[FC-DEBUG] SSE onerror disparado para api:", api, "— reconectando em 4s");
      console.trace("[FC-DEBUG] SSE onerror stack:");
      es.close();
      // Reconecta automaticamente após 4s se ainda estiver autenticado
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        if (authenticatedRef.current) {
          connectSse(api);
        }
      }, 4000);
    };
  }

  useEffect(() => {
    let cancelled = false;
    async function loadSession() {
      try {
        const serverFromPath = getServerFromPathname(window.location.pathname);
        const res = await fetch("/api/server/session");
        if (!res.ok) throw new Error(await res.text());
        const data = (await res.json()) as {
          authenticated: boolean;
          serverName?: string;
        };
        if (cancelled) return;

        if (!data.authenticated) {
          authenticatedRef.current = false;
          try {
            sessionStorage.removeItem("fc_auth");
            sessionStorage.removeItem("fc_server");
            sessionStorage.removeItem("fc_selected_api");
            sessionStorage.removeItem("fc_active_tab");
          } catch { /* ignore */ }
          setAuthenticated(false);
          setCurrentServerName("");
          setLoginServerName(serverFromPath);
          setLoginPassword("");
          hasLoadedOnce.current = false;
          return;
        }

        const sessionServer = normalizeServerName(data.serverName ?? "");

        if (serverFromPath && serverFromPath !== sessionServer) {
          try {
            const switchRes = await fetch("/api/server/login", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ serverName: serverFromPath, password: "" }),
            });
            if (!switchRes.ok) {
              authenticatedRef.current = false;
              try {
                sessionStorage.removeItem("fc_auth");
                sessionStorage.removeItem("fc_server");
                sessionStorage.removeItem("fc_selected_api");
                sessionStorage.removeItem("fc_active_tab");
              } catch { /* ignore */ }
              setAuthenticated(false);
              setCurrentServerName("");
              setLoginServerName(serverFromPath);
              setLoginPassword("");
              setLoginError("Informe a senha para acessar este server.");
              return;
            }
            const switched = (await switchRes.json()) as {
              ok: boolean;
              serverName: string;
            };
            if (switched.ok) {
              setAuthenticated(true);
              setCurrentServerName(switched.serverName);
              setLoginServerName(switched.serverName);
              setLoginPassword("");
              setError(null);
              setLoading(true);
              return;
            }
          } catch {
            setAuthenticated(false);
            setCurrentServerName("");
            setLoginServerName(serverFromPath);
            setLoginPassword("");
            setLoginError("Não foi possível trocar de server automaticamente.");
            return;
          }
        }

        authenticatedRef.current = true;
        try { sessionStorage.setItem("fc_auth", "1"); sessionStorage.setItem("fc_server", sessionServer); } catch { /* ignore */ }
        setAuthenticated(true);
        setCurrentServerName(sessionServer);
        setLoginServerName(sessionServer);
        setLoginPassword("");
        setError(null);

        if (!serverFromPath || serverFromPath !== sessionServer) {
          window.history.replaceState({}, "", buildServerPath(sessionServer));
        }
      } catch {
        if (!cancelled) {
          setAuthenticated(false);
          setCurrentServerName("");
          const serverFromPath = getServerFromPathname(window.location.pathname);
          setLoginServerName(serverFromPath);
        }
      } finally {
        if (!cancelled) setSessionReady(true);
      }
    }
    loadSession();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    void loadDisplaySettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated]);

  // Load data whenever authenticated or selectedApi changes
  useEffect(() => {
    if (!authenticated) return;

    console.info("[FC-DEBUG] effect [auth,api] rodou — authenticated:", authenticated, "selectedApi:", selectedApi, "hasLoadedOnce:", hasLoadedOnce.current);

    // Detect if the user actually switched to a different API (not just an initial mount).
    const apiSwitched =
      prevSelectedApiRef.current !== null && prevSelectedApiRef.current !== selectedApi;
    if (selectedApi) prevSelectedApiRef.current = selectedApi;

    // Always refresh the API list (handles auto-select when selectedApi is empty)
    void loadApiList();

    if (!selectedApi) return; // Aguarda a seleção de uma API

    let cancelled = false;

    async function loadSnapshot(isInitial: boolean) {
      // Só bloqueia a UI na carga inicial (sem dados ainda).
      // Mudanças de API fazem refresh silencioso — mantém dados anteriores visíveis.
      if (isInitial) {
        setLoading(true);
      } else {
        setRefreshing(true);
      }
      setExpandedIds([]);
      // Only reset the route-config form when the user switches to a different API.
      // On initial mount, we preserve whatever was restored from sessionStorage.
      if (apiSwitched) {
        setConfigRouteId(null);
        try { sessionStorage.removeItem("fc_config_state"); } catch { /* ignore */ }
      }
      try {
        const [logsRes, routesRes] = await Promise.all([
          fetch(`/api/logs?apiName=${encodeURIComponent(selectedApi)}`),
          fetch(`/api/routes?apiName=${encodeURIComponent(selectedApi)}`),
        ]);
        if (!logsRes.ok) throw new Error(await logsRes.text());
        if (!routesRes.ok) throw new Error(await routesRes.text());
        const [logsData, routesData] = (await Promise.all([
          logsRes.json(),
          routesRes.json(),
        ])) as [ApiRequestLog[], ApiRouteStat[]];
        if (!cancelled) {
          setLogs(logsData);
          setRoutes(routesData);
          setError(null);
          setLoading(false);
          setRefreshing(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
          setRefreshing(false);
        }
      }
    }

    const isInitial = !hasLoadedOnce.current;
    hasLoadedOnce.current = true;
    loadSnapshot(isInitial);
    connectSse(selectedApi);

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      sseRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, selectedApi]);

  useEffect(() => {
    setLogsPage(1);
  }, [selectedApi]);

  useEffect(() => {
    setLogsPage((p) => {
      const total = Math.max(1, Math.ceil(logs.length / LOGS_PAGE_SIZE));
      return Math.min(Math.max(1, p), total);
    });
  }, [logs.length]);

  if (!sessionReady) {
    return (
      <div className="min-h-screen bg-zinc-50 font-sans text-zinc-900 dark:bg-black dark:text-zinc-50">
        <main className="mx-auto flex min-h-screen max-w-md items-center px-4">
          <div className="w-full rounded-lg border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
            <p className="text-sm text-zinc-600 dark:text-zinc-300">Carregando...</p>
          </div>
        </main>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="min-h-screen bg-zinc-50 font-sans text-zinc-900 dark:bg-black dark:text-zinc-50">
        <main className="mx-auto flex min-h-screen max-w-md items-center px-4">
          <form
            className="w-full rounded-lg border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
            onSubmit={async (e) => {
              e.preventDefault();
              setLoginError(null);
              setLoginSubmitting(true);
              try {
                const res = await fetch("/api/server/login", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    serverName: loginServerName.trim(),
                    password: loginPassword,
                  }),
                });
                if (!res.ok) {
                  const errBody = (await res.json().catch(() => null)) as {
                    error?: string;
                  } | null;
                  throw new Error(
                    errBody?.error ||
                      "Não foi possível entrar. Confira os dados e tente novamente.",
                  );
                }
                const data = (await res.json()) as {
                  ok: boolean;
                  serverName: string;
                };
                if (data.ok) {
                  authenticatedRef.current = true;
                  try { sessionStorage.setItem("fc_auth", "1"); sessionStorage.setItem("fc_server", data.serverName); } catch { /* ignore */ }
                  setAuthenticated(true);
                  setCurrentServerName(data.serverName);
                  window.history.replaceState(
                    {},
                    "",
                    buildServerPath(data.serverName),
                  );
                  setLoading(true);
                  return;
                }
                throw new Error("Não foi possível entrar. Tente novamente.");
              } catch (err) {
                setLoginError(
                  err instanceof Error
                    ? err.message
                    : "Não foi possível entrar. Tente novamente.",
                );
              } finally {
                setLoginSubmitting(false);
              }
            }}
          >
            <div className="flex items-center gap-3">
              <img
                src="/logo.png"
                alt="Freeceptor"
                width={56}
                height={56}
                className="size-14 shrink-0 rounded-md"
              />
              <div className="min-w-0">
                <h1 className="text-xl font-semibold tracking-tight">Freeceptor</h1>
                <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
                  Entre com o server config para acessar requests e rotas.
                </p>
              </div>
            </div>
            <div className="mt-4 space-y-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-zinc-500">Server name</span>
                <input
                  type="text"
                  className="h-9 rounded border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                  value={loginServerName}
                  onChange={(e) => setLoginServerName(e.target.value)}
                  placeholder="Digite o nome do server"
                  required
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-zinc-500">Senha (opcional)</span>
                <input
                  type="password"
                  className="h-9 rounded border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  placeholder="Digite a senha do server (opcional)"
                />
              </label>
            </div>
            {loginError && (
              <div className="mt-3 rounded-md bg-red-100 px-3 py-2 text-xs text-red-800 dark:bg-red-900/40 dark:text-red-200">
                {loginError}
              </div>
            )}
            <button
              type="submit"
              disabled={loginSubmitting}
              className="mt-4 inline-flex h-9 items-center rounded bg-zinc-900 px-4 text-sm font-medium text-zinc-50 hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              {loginSubmitting ? "Entrando..." : "Entrar"}
            </button>
          </form>
        </main>
      </div>
    );
  }

  const currentApiConfig = apiList.find(
    (a) => a.apiName.toLowerCase() === selectedApi.toLowerCase(),
  );
  const apiHasProxy =
    currentApiConfig &&
    ((currentApiConfig.proxyMode && currentApiConfig.proxyUrl) ||
      (currentApiConfig.proxyToClient &&
        currentApiConfig.proxyClientId &&
        currentApiConfig.proxyServiceName));
  const apiHasUrlProxy = Boolean(
    currentApiConfig?.proxyMode && currentApiConfig.proxyUrl,
  );
  const apiHasClientProxy = Boolean(
    currentApiConfig?.proxyToClient &&
      currentApiConfig.proxyClientId &&
      currentApiConfig.proxyServiceName,
  );
  const apiProxyClientOnline = Boolean(
    apiHasClientProxy &&
      connectedClients.some(
        (c) =>
          c.clientId === currentApiConfig?.proxyClientId &&
          c.status === "online",
      ),
  );
  const apiClientProxyInactive = apiHasClientProxy && !apiProxyClientOnline;

  const logsTotalPages = Math.max(1, Math.ceil(logs.length / LOGS_PAGE_SIZE));
  const safeLogsPage = Math.min(Math.max(1, logsPage), logsTotalPages);
  const logsPageStart = logs.length === 0 ? 0 : (safeLogsPage - 1) * LOGS_PAGE_SIZE + 1;
  const logsPageEnd = Math.min(safeLogsPage * LOGS_PAGE_SIZE, logs.length);
  const paginatedLogs = logs.slice(
    (safeLogsPage - 1) * LOGS_PAGE_SIZE,
    safeLogsPage * LOGS_PAGE_SIZE,
  );

  return (
    <div className="min-h-screen bg-zinc-50 font-sans text-zinc-900 dark:bg-black dark:text-zinc-50">
      <main className="mx-auto flex h-screen max-w-5xl min-h-0 flex-col gap-4 overflow-hidden px-4 py-8">
        {/* Header */}
        <header className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <img
              src="/logo.png"
              alt="Freeceptor"
              width={72}
              height={72}
              className="size-[72px] shrink-0 rounded-md"
            />
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold leading-tight tracking-tight">
                Freeceptor
              </h1>
              <p className="mt-0.5 text-xs leading-snug text-zinc-500 dark:text-zinc-400">
                Server: <code className="font-mono">{currentServerName}</code>
              </p>
              <p className="mt-1 text-sm leading-snug text-zinc-600 dark:text-zinc-400">
                Toda chamada a{" "}
                <button
                  type="button"
                  title={urlCopied ? "Copiado!" : "Clique para copiar"}
                  onClick={copyUrl}
                  className={cn(
                    "inline-flex items-center gap-1 rounded px-1 font-mono text-[13px] transition-colors",
                    urlCopied
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                      : "bg-zinc-100 text-zinc-800 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700",
                  )}
                >
                  {baseUrl}/api/{currentServerName}/{selectedApi}/*
                  {urlCopied ? (
                    <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                  ) : (
                    <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                  )}
                </button>{" "}
                aparece aqui em tempo real.
              </p>
            </div>
          </div>
          <div className="mt-1 flex shrink-0 items-center gap-2">
            <a
              href={`/server/${currentServerName}/clients`}
              className="flex items-center gap-1.5 rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <span
                className={`h-2 w-2 rounded-full transition-colors ${
                  connectedClients.some((c) => c.status === "online")
                    ? "bg-emerald-500"
                    : "bg-zinc-400"
                }`}
              />
              Clientes
            </a>
            <button
              type="button"
              title="Configurações do servidor"
              aria-label="Configurações do servidor"
              onClick={() => void openSettings()}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-zinc-300 bg-white text-zinc-500 transition-colors hover:border-zinc-400 hover:bg-zinc-50 hover:text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
              </svg>
            </button>
            <button
              type="button"
              title="Sair do servidor"
              aria-label="Sair do servidor"
              onClick={async () => {
                try {
                  await fetch("/api/server/logout", { method: "POST" });
                } catch {
                  // ignore
                } finally {
                  clearLocalSession();
                }
              }}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-zinc-300 bg-white text-zinc-500 transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:border-red-800 dark:hover:bg-red-950/40 dark:hover:text-red-400"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </button>
          </div>
        </header>

        {/* API Selector */}
        <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex min-w-0 flex-1 items-center">
            <div
              ref={apiStripRef}
              className={cn(
                "flex min-w-0 flex-1 flex-wrap items-center gap-2",
                draggingApi ? "select-none" : undefined,
              )}
            >
              {apiList.length === 0 && !showNewApiInput && (
                <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
                  Nenhuma API criada
                </span>
              )}

              {/* APIs from apiList */}
              {apiList.map((api, index) => {
                const unread = unreadByApi[api.apiName.toLowerCase()] ?? 0;
                const isSelected = selectedApi === api.apiName;
                const draggedIndex = draggingApi
                  ? apiList.findIndex((a) => a.apiName === draggingApi)
                  : -1;
                const showInsertBefore =
                  draggingApi != null &&
                  dropInsertIndex === index &&
                  dropInsertIndex !== draggedIndex &&
                  dropInsertIndex !== draggedIndex + 1;

                return (
                  <div
                    key={api.apiName}
                    className="inline-flex items-center"
                  >
                    {showInsertBefore && (
                      <span
                        aria-hidden
                        className="mx-0.5 h-6 w-0.5 shrink-0 rounded-full bg-orange-500"
                      />
                    )}
                    <div
                      data-api-chip={api.apiName}
                      onPointerDown={(e) => beginApiChipDrag(e, api.apiName)}
                      className={cn(
                        "group relative inline-flex touch-none items-center",
                        draggingApi === api.apiName && "opacity-40",
                      )}
                    >
                      <button
                        type="button"
                        title="Arraste para reordenar"
                        className={cn(
                          "inline-flex cursor-grab items-center gap-1.5 rounded-full py-1 pl-2 pr-6 text-[11px] font-medium transition-colors active:cursor-grabbing",
                          isSelected
                            ? "bg-zinc-900 text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                            : "border border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800",
                        )}
                      >
                        <svg
                          aria-hidden
                          viewBox="0 0 10 16"
                          className="h-3.5 w-2.5 shrink-0 text-zinc-400 opacity-50 dark:text-zinc-500"
                          fill="currentColor"
                        >
                          <circle cx="3" cy="3" r="1.2" />
                          <circle cx="7" cy="3" r="1.2" />
                          <circle cx="3" cy="8" r="1.2" />
                          <circle cx="7" cy="8" r="1.2" />
                          <circle cx="3" cy="13" r="1.2" />
                          <circle cx="7" cy="13" r="1.2" />
                        </svg>
                        {!isSelected && unread > 0 && (
                          <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-orange-500 px-1 text-[9px] font-semibold leading-none text-white">
                            {unread > 99 ? "99+" : unread}
                          </span>
                        )}
                        {api.apiName}
                        {api.proxyToClient ? (
                          <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-500" />
                        ) : api.proxyMode ? (
                          <span className="inline-block h-1.5 w-1.5 rounded-full bg-violet-500" />
                        ) : null}
                      </button>
                      <button
                        type="button"
                        data-api-delete
                        aria-label={`Deletar API ${api.apiName}`}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteApiName(api.apiName);
                        }}
                        className={cn(
                          "absolute right-1 flex h-4 w-4 items-center justify-center rounded-full text-[9px] transition-colors",
                          isSelected
                            ? "text-zinc-400 hover:bg-zinc-700 hover:text-zinc-50 dark:text-zinc-600 dark:hover:bg-zinc-200 dark:hover:text-zinc-900"
                            : "text-zinc-400 hover:bg-red-100 hover:text-red-600 dark:text-zinc-600 dark:hover:bg-red-900/40 dark:hover:text-red-400",
                        )}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                );
              })}
              {draggingApi != null &&
                dropInsertIndex === apiList.length &&
                dropInsertIndex !==
                  apiList.findIndex((a) => a.apiName === draggingApi) &&
                dropInsertIndex !==
                  apiList.findIndex((a) => a.apiName === draggingApi) + 1 && (
                  <span
                    aria-hidden
                    className="mx-0.5 h-6 w-0.5 shrink-0 self-center rounded-full bg-orange-500"
                  />
                )}

              {/* Add new API */}
              {showNewApiInput ? (
                <form
                  className="flex items-center gap-1"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const name = newApiName.trim().toLowerCase();
                    if (!name) return;
                    await fetch("/api/apis", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ apiName: name }),
                    });
                    await loadApiList();
                    selectApi(name);
                    setNewApiName("");
                    setShowNewApiInput(false);
                  }}
                >
                  <input
                    autoFocus
                    type="text"
                    placeholder="nome-da-api"
                    className="h-6 rounded border border-zinc-300 bg-white px-2 font-mono text-[11px] text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                    value={newApiName}
                    onChange={(e) => setNewApiName(e.target.value)}
                  />
                  <button
                    type="submit"
                    className="rounded bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                  >
                    +
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowNewApiInput(false);
                      setNewApiName("");
                    }}
                    className="text-[11px] text-zinc-500 hover:text-zinc-700"
                  >
                    ✕
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowNewApiInput(true)}
                  className="inline-flex items-center rounded-full border border-dashed border-zinc-300 px-2.5 py-1 text-[11px] font-medium text-zinc-400 transition-colors hover:border-zinc-400 hover:text-zinc-600 dark:border-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-300"
                >
                  + Nova API
                </button>
              )}
            </div>
          </div>

          {/* API-level proxy config button */}
          <div className="shrink-0 self-center border-l border-zinc-200 pl-2 dark:border-zinc-800">
            <button
              type="button"
              onClick={openApiConfig}
              title={
                apiClientProxyInactive
                  ? "Proxy configurado, mas o cliente está offline"
                  : undefined
              }
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
                apiClientProxyInactive
                  ? "border border-zinc-300 bg-zinc-200 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400"
                  : apiHasClientProxy
                    ? "bg-blue-600 text-white dark:bg-blue-500 dark:text-zinc-950"
                    : apiHasUrlProxy
                      ? "bg-violet-600 text-white dark:bg-violet-500 dark:text-zinc-950"
                      : "border border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800",
              )}
            >
              {apiClientProxyInactive
                ? "Proxy da API (offline)"
                : apiHasProxy
                  ? "Proxy da API ativo"
                  : "Configurar proxy da API"}
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-md bg-red-100 px-3 py-2 text-sm text-red-800 dark:bg-red-900/40 dark:text-red-200">
            Erro ao carregar: {error}
          </div>
        )}

        {/* API-level proxy info banner */}
        {apiHasProxy && (
          <div
            className={cn(
              "rounded-md border px-3 py-2 text-[11px]",
              apiClientProxyInactive
                ? "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400"
                : apiHasClientProxy
                  ? "border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200"
                  : "border-violet-200 bg-violet-50 text-violet-900 dark:border-violet-900/60 dark:bg-violet-950/30 dark:text-violet-200",
            )}
          >
            <span className="font-semibold">
              Proxy da API &quot;{selectedApi}&quot;{" "}
              {apiClientProxyInactive ? "(cliente offline)" : "ativo"}
            </span>
            {currentApiConfig?.proxyMode && currentApiConfig.proxyUrl && (
              <span> → URL: <code className="font-mono">{currentApiConfig.proxyUrl}</code></span>
            )}
            {currentApiConfig?.proxyToClient && currentApiConfig.proxyClientId && (
              <span>
                {" "}→ Cliente:{" "}
                <code className="font-mono">{currentApiConfig.proxyClientId}</code>
                {currentApiConfig.proxyServiceName && (
                  <span> / {currentApiConfig.proxyServiceName}</span>
                )}
              </span>
            )}
            <span
              className={cn(
                "ml-2",
                apiClientProxyInactive
                  ? "text-zinc-500 dark:text-zinc-500"
                  : apiHasClientProxy
                    ? "text-blue-700 dark:text-blue-400"
                    : "text-violet-700 dark:text-violet-400",
              )}
            >
              (rotas com proxy próprio têm prioridade)
            </span>
          </div>
        )}

        {/* Tab bar: Requests / Routes tabs + context actions */}
        <div className="flex items-center justify-between gap-3">
          <div className="inline-flex rounded-full border border-zinc-300 bg-zinc-100 p-1 text-xs font-medium dark:border-zinc-700 dark:bg-zinc-900">
            <button
              type="button"
              onClick={() => setActiveTab("requests")}
              className={`rounded-full px-3 py-1 transition-colors ${
                activeTab === "requests"
                  ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-50"
                  : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"
              }`}
            >
              Requests
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("routes")}
              className={`rounded-full px-3 py-1 transition-colors ${
                activeTab === "routes"
                  ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-50"
                  : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"
              }`}
            >
              Rotas
            </button>
          </div>

          <div className="flex items-center gap-2">
            {activeTab === "routes" && (
              <>
                <div className="group relative">
                  <button
                    type="button"
                    aria-label="Exportar configurações de rotas"
                    className="flex h-8 w-8 items-center justify-center rounded-full border border-zinc-300 bg-white text-[13px] text-zinc-700 shadow-sm transition-all duration-150 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
                    onClick={() => {
                      setExportError(null);
                      setExportFormat("freeceptor");
                      setExportOpen(true);
                    }}
                  >
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 3v12" />
                      <path d="m7 10 5 5 5-5" />
                      <path d="M5 21h14" />
                    </svg>
                  </button>
                  <span className="pointer-events-none absolute -bottom-7 left-1/2 -translate-x-1/2 rounded bg-zinc-900 px-2 py-0.5 text-[10px] text-zinc-50 opacity-0 shadow-sm transition-opacity duration-100 group-hover:opacity-100 dark:bg-zinc-100 dark:text-zinc-900">
                    Exportar
                  </span>
                </div>
                <div className="group relative">
                  <button
                    type="button"
                    aria-label="Importar configurações de rotas"
                    className="flex h-8 w-8 items-center justify-center rounded-full border border-zinc-300 bg-white text-[13px] text-zinc-700 shadow-sm transition-all duration-150 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
                    onClick={() => {
                      setImportError(null);
                      setImportText("");
                      setImportFileName(null);
                      setImportDetected(null);
                      setImportOpen(true);
                    }}
                  >
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 21V9" />
                      <path d="m7 14 5-5 5 5" />
                      <path d="M5 3h14" />
                    </svg>
                  </button>
                  <span className="pointer-events-none absolute -bottom-7 left-1/2 -translate-x-1/2 rounded bg-zinc-900 px-2 py-0.5 text-[10px] text-zinc-50 opacity-0 shadow-sm transition-opacity duration-100 group-hover:opacity-100 dark:bg-zinc-100 dark:text-zinc-900">
                    Importar
                  </span>
                </div>
              </>
            )}
            {activeTab === "requests" && (
              <div className="group relative">
                <button
                  type="button"
                  aria-label="Limpar requisições"
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-zinc-300 bg-white text-[13px] text-zinc-700 shadow-sm transition-colors hover:bg-red-50 hover:text-red-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-red-900/40 dark:hover:text-red-200"
                  onClick={() => setClearRequestsOpen(true)}
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" /><path d="M10 10v7" /><path d="M14 10v7" />
                  </svg>
                </button>
                <span className="pointer-events-none absolute -bottom-7 left-1/2 -translate-x-1/2 rounded bg-zinc-900 px-2 py-0.5 text-[10px] text-zinc-50 opacity-0 shadow-sm transition-opacity duration-100 group-hover:opacity-100 dark:bg-zinc-100 dark:text-zinc-900">
                  Limpar requisições
                </span>
              </div>
            )}
            {refreshing && !loading && (
              <span className="h-4 w-4 animate-spin rounded-full border border-zinc-400 border-t-transparent dark:border-zinc-500" />
            )}
          </div>
        </div>

        {/* Main content */}
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          {!selectedApi ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full border border-dashed border-zinc-300 text-2xl text-zinc-400 dark:border-zinc-700">
                +
              </div>
              <div>
                <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  Nenhuma API criada ainda
                </p>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  Crie uma API para começar a interceptar chamadas neste server.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowNewApiInput(true)}
                className="inline-flex items-center rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                + Criar primeira API
              </button>
            </div>
          ) : (
          <>
          <div className="shrink-0 border-b border-zinc-200 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            {activeTab === "requests"
              ? loading
                ? "Carregando requisições..."
                : `${logs.length} requisições registradas (mostrando as mais recentes primeiro)`
              : loading
                ? "Carregando rotas..."
                : `${routes.length} combinações método + path`}
          </div>

          <div className="min-h-0 flex-1 overflow-auto text-xs">
            {activeTab === "requests" ? (
              <div className="space-y-3 p-3">
                {paginatedLogs.map((log) => (
                  <div
                    key={log.id}
                    className="rounded-md border border-zinc-200 bg-white shadow-sm transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900/60"
                  >
                    <div
                      className="grid cursor-pointer grid-cols-[auto_auto_1fr_auto] items-center gap-3 px-3 py-2"
                      onClick={() => toggleLogExpanded(log.id)}
                    >
                      <span className="font-mono text-[11px]">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </span>
                      <span
                        className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold"
                        style={{
                          backgroundColor:
                            log.method === "GET"
                              ? "rgba(59,130,246,0.1)"
                              : log.method === "POST"
                                ? "rgba(16,185,129,0.1)"
                                : "rgba(148,163,184,0.1)",
                          color:
                            log.method === "GET"
                              ? "#1d4ed8"
                              : log.method === "POST"
                                ? "#047857"
                                : "#334155",
                        }}
                      >
                        {log.method}
                      </span>
                      <span className="inline-flex items-center gap-2 font-mono text-[11px]">
                        <span>{log.path || "-"}</span>
                        {(() => {
                          const mode: ResponseModeBadge = log.proxyClientId
                            ? "client"
                            : log.proxyTargetUrl
                              ? "url"
                              : "mock";
                          const isOverride = Boolean(log.overrodeApiProxy);
                          const clientOffline =
                            mode === "client" &&
                            (Boolean(log.proxyClientOffline) ||
                              (log.responseStatus === 502 &&
                                typeof log.responseBody === "object" &&
                                log.responseBody != null &&
                                "error" in log.responseBody &&
                                String(
                                  (log.responseBody as { error?: unknown }).error,
                                ).includes("cliente conectado")));
                          const title = clientOffline
                            ? isOverride
                              ? "Proxy client offline (sobrescreve o proxy da API)"
                              : "Proxy client offline (da API)"
                            : isOverride
                              ? mode === "mock"
                                ? "Mock (sobrescreve o proxy da API)"
                                : mode === "url"
                                  ? "Proxy URL (sobrescreve o proxy da API)"
                                  : "Proxy client (sobrescreve o proxy da API)"
                              : mode === "client"
                                ? "Proxy client (da API)"
                                : mode === "url"
                                  ? "Proxy URL (da API)"
                                  : "Mock (comportamento padrão)";
                          return (
                            <span
                              className={responseModeBadgeClass(
                                mode,
                                isOverride ? "filled" : "outline",
                                clientOffline,
                              )}
                              title={title}
                            >
                              {clientOffline ? "client · offline" : mode}
                            </span>
                          );
                        })()}
                      </span>
                      {!expandedIds.includes(log.id) && (
                        <span
                          className={cn(
                            "inline-flex min-w-12 items-center justify-center rounded-full px-2.5 py-1 font-mono text-[12px] font-semibold",
                            statusPillClass(log.responseStatus),
                          )}
                        >
                          {log.responseStatus}
                        </span>
                      )}
                    </div>

                    {expandedIds.includes(log.id) && (
                      <div className="border-t border-zinc-100 bg-zinc-50 px-3 py-3 text-[11px] text-zinc-700 dark:border-zinc-900 dark:bg-zinc-900 dark:text-zinc-200">
                        <LogThreadBlock
                          icon={<span className="block leading-none">→</span>}
                          title="Dados da request"
                        >
                          <KeyValueViewer
                            label="Query Params"
                            data={log.queryParams ?? {}}
                            defaultBodyMode={displayBodyMode}
                            defaultJsonCollapsed={displayJsonCollapsed}
                          />
                          <KeyValueViewer
                            label="Headers"
                            data={log.headers ?? {}}
                            defaultBodyMode={displayBodyMode}
                            defaultJsonCollapsed={displayJsonCollapsed}
                          />
                          <JsonBodyViewer
                            value={log.body}
                            defaultBodyMode={displayBodyMode}
                            defaultJsonCollapsed={displayJsonCollapsed}
                          />
                        </LogThreadBlock>
                        <div className="mt-4 border-t border-dashed border-zinc-200 pt-4 dark:border-zinc-700">
                          <LogThreadBlock
                            icon={<span className="block leading-none">←</span>}
                            title="Dados da resposta"
                            titleAside={
                              <span
                                className={cn(
                                  "inline-flex min-w-12 items-center justify-center rounded-full px-2.5 py-1 font-mono text-[12px] font-semibold",
                                  statusPillClass(log.responseStatus),
                                )}
                              >
                                {log.responseStatus}
                              </span>
                            }
                            prelude={
                              <>
                                {log.proxyTargetUrl ? (
                                  <div className="mb-2 rounded border border-violet-200 bg-violet-50 px-2 py-1.5 text-[11px] text-violet-900 dark:border-violet-900/60 dark:bg-violet-950/30 dark:text-violet-200">
                                    <div>
                                      <span className="font-semibold">
                                        Proxy URL habilitado
                                      </span>
                                      <span>, respondido por:</span>
                                    </div>
                                    <div className="mt-2 break-all font-mono text-[11px] font-semibold">
                                      {log.proxyResolvedUrl ?? log.proxyTargetUrl}
                                    </div>
                                  </div>
                                ) : null}
                                {log.proxyClientId
                                  ? (() => {
                                      const clientOffline =
                                        Boolean(log.proxyClientOffline) ||
                                        (log.responseStatus === 502 &&
                                          typeof log.responseBody === "object" &&
                                          log.responseBody != null &&
                                          "error" in log.responseBody &&
                                          String(
                                            (
                                              log.responseBody as {
                                                error?: unknown;
                                              }
                                            ).error,
                                          ).includes("cliente conectado"));
                                      return (
                                        <div
                                          className={cn(
                                            "mb-2 rounded border px-2 py-1.5 text-[11px]",
                                            clientOffline
                                              ? "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400"
                                              : "border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200",
                                          )}
                                        >
                                          <div>
                                            <span className="font-semibold">
                                              Proxy Client habilitado
                                            </span>
                                            <span>
                                              {clientOffline
                                                ? ", cliente offline/indisponível:"
                                                : ", respondido pelo cliente:"}
                                            </span>
                                          </div>
                                          <div className="mt-2 flex items-center gap-2">
                                            <span
                                              className={cn(
                                                "rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold",
                                                clientOffline
                                                  ? "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                                                  : "bg-blue-200 text-blue-800 dark:bg-blue-800 dark:text-blue-200",
                                              )}
                                            >
                                              {log.proxyClientName ||
                                                log.proxyClientId}
                                            </span>
                                            <span
                                              className={cn(
                                                clientOffline
                                                  ? "text-zinc-500"
                                                  : "text-blue-600 dark:text-blue-400",
                                              )}
                                            >
                                              →
                                            </span>
                                            <span className="font-mono text-[11px]">
                                              {log.proxyServiceName}
                                            </span>
                                          </div>
                                        </div>
                                      );
                                    })()
                                  : null}
                              </>
                            }
                          >
                            <KeyValueViewer
                              label="Headers"
                              data={log.responseHeaders ?? {}}
                              defaultBodyMode={displayBodyMode}
                              defaultJsonCollapsed={displayJsonCollapsed}
                            />
                            <JsonBodyViewer
                              value={log.responseBody}
                              defaultBodyMode={displayBodyMode}
                              defaultJsonCollapsed={displayJsonCollapsed}
                            />
                          </LogThreadBlock>
                        </div>
                      </div>
                    )}
                  </div>
                ))}

                {!loading && logs.length === 0 && (
                  <div className="flex items-center gap-3 rounded border border-dashed border-zinc-300 px-3 py-6 text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-500">
                    <svg className="ml-2 shrink-0 text-zinc-400 dark:text-zinc-600" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
                      <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" />
                    </svg>
                    Nenhuma requisição recebida ainda.
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-3 p-3">
                {/* Add-route card — always at the top */}
                {!loading && (
                  <div>
                    {!showAddRouteForm ? (
                      routes.length === 0 ? (
                        /* Empty state — full-width dashed card */
                        <button
                          type="button"
                          onClick={() => {
                            setNewRoutePath("/");
                            setNewRouteMethod("GET");
                            setNewRouteError(null);
                            setShowAddRouteForm(true);
                          }}
                          className="group w-full cursor-pointer rounded border border-dashed border-zinc-300 px-3 py-6 text-left transition-colors hover:border-zinc-400 dark:border-zinc-700 dark:hover:border-zinc-600 dark:hover:text-zinc-300"
                        >
                          <span className="flex items-center gap-3">
                            <svg className="ml-2 shrink-0 text-zinc-400 transition-colors group-hover:text-zinc-500 dark:text-zinc-600 dark:group-hover:text-zinc-300" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                              <line x1="12" y1="5" x2="12" y2="19" />
                              <line x1="5" y1="12" x2="19" y2="12" />
                            </svg>
                            <span className="text-xs text-zinc-500 transition-colors dark:text-zinc-500 dark:group-hover:text-zinc-300">
                              Faça uma chamada para a API ou adicione uma rota manualmente clicando aqui.
                            </span>
                          </span>
                        </button>
                      ) : (
                        /* Compact — same full-width dashed card layout as empty state */
                        <button
                          type="button"
                          onClick={() => {
                            setNewRoutePath("/");
                            setNewRouteMethod("GET");
                            setNewRouteError(null);
                            setShowAddRouteForm(true);
                          }}
                          className="group w-full cursor-pointer rounded border border-dashed border-zinc-300 px-3 py-6 text-left transition-colors hover:border-zinc-400 dark:border-zinc-700 dark:hover:border-zinc-600 dark:hover:text-zinc-300"
                        >
                          <span className="flex items-center gap-3">
                            <svg className="ml-2 shrink-0 text-zinc-400 transition-colors group-hover:text-zinc-500 dark:text-zinc-600 dark:group-hover:text-zinc-300" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                              <line x1="12" y1="5" x2="12" y2="19" />
                              <line x1="5" y1="12" x2="19" y2="12" />
                            </svg>
                            <span className="text-xs text-zinc-500 transition-colors dark:text-zinc-500 dark:group-hover:text-zinc-300">
                              Faça uma chamada para a API ou adicione uma rota manualmente clicando aqui.
                            </span>
                          </span>
                        </button>
                      )
                    ) : (
                      <div className="rounded border border-zinc-200 bg-zinc-50 px-3 py-3 dark:border-zinc-800 dark:bg-zinc-900">
                        <p className="mb-2 text-[11px] font-medium text-zinc-500">Nova rota</p>
                        <form
                          className="flex flex-wrap items-center gap-2"
                          onSubmit={async (e) => {
                            e.preventDefault();
                            const trimmedPath = newRoutePath.trim();
                            if (!trimmedPath || trimmedPath === "") {
                              setNewRouteError("Informe o path da rota.");
                              return;
                            }
                            const normalizedPath = trimmedPath.startsWith("/")
                              ? trimmedPath
                              : `/${trimmedPath}`;
                            setNewRouteSaving(true);
                            setNewRouteError(null);
                            try {
                              const res = await fetch("/api/routes", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                  apiName: selectedApi,
                                  method: newRouteMethod,
                                  path: normalizedPath,
                                  status: 200,
                                  headers: {},
                                  responseBody: { status: "ok" },
                                  proxyMode: false,
                                  proxyUrl: "",
                                  proxyToClient: false,
                                  proxyClientId: "",
                                  proxyServiceName: "",
                                  // Placeholder until the user saves an override in the panel.
                                  explicitlyConfigured: false,
                                  mockMode: "dynamic",
                                  dynamicRules: [],
                                }),
                              });
                              if (!res.ok) {
                                const text = await res.text();
                                throw new Error(text);
                              }
                              setShowAddRouteForm(false);
                              setNewRoutePath("/");
                              setNewRouteMethod("GET");
                              // Refresh the routes list immediately without waiting for SSE
                              try {
                                const routesRes = await fetch(`/api/routes?apiName=${encodeURIComponent(selectedApi)}`);
                                if (routesRes.ok) {
                                  setRoutes(await routesRes.json() as ApiRouteStat[]);
                                }
                              } catch { /* non-fatal, SSE will catch it */ }
                            } catch (err) {
                              setNewRouteError(
                                err instanceof Error ? err.message : "Erro ao criar rota.",
                              );
                            } finally {
                              setNewRouteSaving(false);
                            }
                          }}
                        >
                          <select
                            value={newRouteMethod}
                            onChange={(e) => setNewRouteMethod(e.target.value)}
                            className="h-7 rounded border border-zinc-300 bg-white px-1.5 font-mono text-[11px] font-semibold text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                          >
                            {["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].map((m) => (
                              <option key={m} value={m}>{m}</option>
                            ))}
                          </select>
                          <input
                            type="text"
                            autoFocus
                            value={newRoutePath}
                            onChange={(e) => setNewRoutePath(e.target.value)}
                            placeholder="/caminho/da/rota"
                            className="h-7 min-w-48 flex-1 rounded border border-zinc-300 bg-white px-2 font-mono text-[11px] text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                          />
                          <button
                            type="submit"
                            disabled={newRouteSaving}
                            className="h-7 rounded bg-zinc-900 px-3 text-[11px] font-medium text-zinc-50 hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                          >
                            {newRouteSaving ? "Criando…" : "Criar rota"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setShowAddRouteForm(false)}
                            className="h-7 rounded border border-zinc-200 px-3 text-[11px] text-zinc-500 hover:border-zinc-300 hover:text-zinc-700 dark:border-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-300"
                          >
                            Cancelar
                          </button>
                          {newRouteError && (
                            <span className="w-full text-[11px] text-red-500">{newRouteError}</span>
                          )}
                        </form>
                      </div>
                    )}
                  </div>
                )}
                {routes.map((route) => (
                  <div
                    key={route.id}
                    className="rounded-md border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
                  >
                    <div
                      className="grid cursor-pointer grid-cols-[auto_1fr_auto_auto_auto] items-center gap-3 px-3 py-2"
                      onClick={() => {
                        void openRouteConfig(route);
                      }}
                    >
                      <span
                        className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold"
                        style={{
                          backgroundColor:
                            route.method === "GET"
                              ? "rgba(59,130,246,0.1)"
                              : route.method === "POST"
                                ? "rgba(16,185,129,0.1)"
                                : "rgba(148,163,184,0.1)",
                          color:
                            route.method === "GET"
                              ? "#1d4ed8"
                              : route.method === "POST"
                                ? "#047857"
                                : "#334155",
                        }}
                      >
                        {route.method}
                      </span>
                      <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5 font-mono text-[11px]">
                        {(() => {
                          const segments = route.path.split("/").filter(Boolean);
                          if (segments.length === 0) return "-";
                          return segments.map((seg, i) => (
                            <span key={`${route.id}-${i}`}>
                              {isPathParamSegmentFront(seg) ? (
                                editingWildcardSegment?.routeId === route.id &&
                                editingWildcardSegment.segIndex === i ? (
                                  <form
                                    className="inline-flex items-center gap-1"
                                    onClick={(e) => e.stopPropagation()}
                                    onSubmit={(e) => {
                                      e.preventDefault();
                                      void renameNamedPathParam(
                                        route,
                                        i,
                                        segments,
                                        editingWildcardSegment.value,
                                      );
                                    }}
                                  >
                                    <span className="font-mono text-[11px] text-zinc-400">
                                      :
                                    </span>
                                    <input
                                      autoFocus
                                      type="text"
                                      placeholder="nome"
                                      className="h-5 w-24 rounded border border-zinc-300 bg-white px-1.5 font-mono text-[11px] text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                                      value={editingWildcardSegment.value}
                                      onChange={(e) =>
                                        setEditingWildcardSegment((prev) =>
                                          prev ? { ...prev, value: e.target.value } : null,
                                        )
                                      }
                                      disabled={segmentEditSaving}
                                    />
                                    <button
                                      type="submit"
                                      disabled={segmentEditSaving}
                                      className="inline-flex h-5 w-5 items-center justify-center rounded bg-zinc-900 text-zinc-50 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
                                      aria-label="Confirmar"
                                    >
                                      <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                        <path d="M5 13l4 4L19 7" />
                                      </svg>
                                    </button>
                                    <button
                                      type="button"
                                      disabled={segmentEditSaving}
                                      onClick={() => setEditingWildcardSegment(null)}
                                      className="text-[11px] text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                                    >
                                      ×
                                    </button>
                                  </form>
                                ) : (
                                  <button
                                    type="button"
                                    className="rounded bg-amber-100 px-1 text-amber-800 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-200 dark:hover:bg-amber-900/60"
                                    title={
                                      seg === "*"
                                        ? "Clique para nomear o parâmetro"
                                        : "Clique para renomear o parâmetro"
                                    }
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (seg === "*") {
                                        handleSegmentClick(route, i, segments);
                                        return;
                                      }
                                      setEditingWildcardSegment({
                                        routeId: route.id,
                                        segIndex: i,
                                        value: seg.startsWith(":")
                                          ? seg.slice(1)
                                          : seg,
                                      });
                                    }}
                                  >
                                    {seg}
                                  </button>
                                )
                              ) : (
                                <button
                                  type="button"
                                  className="text-zinc-800 hover:text-blue-600 hover:underline dark:text-zinc-200 dark:hover:text-blue-400"
                                  title="Clique para converter em parâmetro nomeado"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleSegmentClick(route, i, segments);
                                  }}
                                >
                                  {seg}
                                </button>
                              )}
                              {i < segments.length - 1 && (
                                <span className="text-zinc-400"> / </span>
                              )}
                            </span>
                          ));
                        })()}
                        {(() => {
                          const apiHasProxy = apiHasClientProxy || apiHasUrlProxy;
                          const inheritsApiProxy =
                            !route.overrideMode && apiHasProxy;
                          // Preenchido só quando a rota sobrescreve um proxy ativo da API.
                          const isOverride = Boolean(route.overrideMode) && apiHasProxy;
                          const mode: ResponseModeBadge = inheritsApiProxy
                            ? apiHasClientProxy
                              ? "client"
                              : "url"
                            : route.overrideMode === "url"
                              ? "url"
                              : route.overrideMode === "client"
                                ? "client"
                                : "mock";
                          const effectiveClientId =
                            mode === "client"
                              ? route.overrideMode === "client"
                                ? route.proxyClientId
                                : currentApiConfig?.proxyClientId
                              : undefined;
                          const clientOffline = Boolean(
                            effectiveClientId &&
                              !connectedClients.some(
                                (c) =>
                                  c.clientId === effectiveClientId &&
                                  c.status === "online",
                              ),
                          );
                          const title = clientOffline
                            ? isOverride
                              ? "Proxy client offline (sobrescreve o proxy da API)"
                              : "Proxy client offline (da API)"
                            : isOverride
                              ? mode === "mock"
                                ? "Mock (sobrescreve o proxy da API)"
                                : mode === "url"
                                  ? "Proxy URL (sobrescreve o proxy da API)"
                                  : "Proxy client (sobrescreve o proxy da API)"
                              : inheritsApiProxy
                                ? mode === "client"
                                  ? "Proxy client (da API)"
                                  : "Proxy URL (da API)"
                                : "Mock (comportamento padrão)";
                          return (
                            <span
                              className={responseModeBadgeClass(
                                mode,
                                isOverride ? "filled" : "outline",
                                clientOffline,
                              )}
                              title={title}
                            >
                              {clientOffline ? "client · offline" : mode}
                            </span>
                          );
                        })()}
                      </span>
                      <span className="text-[11px] text-zinc-600 dark:text-zinc-300">
                        chamadas: {route.count}
                      </span>
                      <span className="font-mono text-[11px] text-zinc-600 dark:text-zinc-300">
                        {route.lastTimestamp
                          ? new Date(route.lastTimestamp).toLocaleTimeString()
                          : "-"}
                      </span>
                      <div className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          aria-label="Remover configuração desta rota"
                          className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-zinc-300 text-[11px] text-zinc-600 hover:bg-red-50 hover:text-red-700 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-red-900/40 dark:hover:text-red-200"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteRouteTarget(route);
                          }}
                        >
                          <svg
                            viewBox="0 0 24 24"
                            className="h-3.5 w-3.5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M3 6h18" />
                            <path d="M8 6V4h8v2" />
                            <path d="M6 6l1 14h10l1-14" />
                            <path d="M10 10v7" />
                            <path d="M14 10v7" />
                          </svg>
                        </button>
                      </div>
                    </div>

                    {configRouteId === route.id && (
                      <div className="border-t border-zinc-100 bg-zinc-50 px-3 py-3 text-[11px] text-zinc-700 dark:border-zinc-900 dark:bg-zinc-900 dark:text-zinc-200">
                        <form
                          className="flex flex-col gap-2"
                          onSubmit={async (e) => {
                            e.preventDefault();
                            setConfigMessage(null);
                            try {
                              const isPatternPath = pathHasParamsFront(route.path);

                              if (configProxyModeType === null) {
                                if (isPatternPath) {
                                  const statusNumber = Number(configStatus) || 200;
                                  const parsedBody = configBody
                                    ? JSON.parse(configBody)
                                    : { status: "ok" };
                                  const parsedHeaders = configHeaders
                                    ? JSON.parse(configHeaders)
                                    : {};
                                  const res = await fetch("/api/routes", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({
                                      apiName: selectedApi,
                                      method: route.method,
                                      path: route.path,
                                      status: statusNumber,
                                      headers: parsedHeaders,
                                      responseBody: parsedBody,
                                      proxyMode: false,
                                      proxyUrl: "",
                                      proxyToClient: false,
                                      proxyClientId: "",
                                      proxyServiceName: "",
                                      explicitlyConfigured: false,
                                      mockMode: "dynamic",
                                      dynamicRules: [],
                                    }),
                                  });
                                  if (!res.ok) throw new Error(await res.text());
                                } else {
                                  const res = await fetch("/api/routes", {
                                    method: "DELETE",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({
                                      apiName: selectedApi,
                                      method: route.method,
                                      path: route.path,
                                    }),
                                  });
                                  if (!res.ok) throw new Error(await res.text());
                                }
                                setRoutes((prev) =>
                                  prev.map((r) =>
                                    r.id === route.id
                                      ? { ...r, overrideMode: undefined }
                                      : r,
                                  ),
                                );
                                setConfigMessage(
                                  "Override removido. Esta rota usará o proxy da API.",
                                );
                                return;
                              }

                              if (configProxyModeType === "url" && !configProxyUrl.trim()) {
                                throw new Error("Informe a URL do proxy.");
                              }
                              if (configProxyModeType === "client") {
                                if (!configProxyClientId) {
                                  throw new Error("Selecione um cliente conectado.");
                                }
                                if (!configProxyServiceName) {
                                  throw new Error("Selecione um serviço do cliente.");
                                }
                              }

                              const statusNumber = Number(configStatus) || 200;
                              const parsedBody = configBody ? JSON.parse(configBody) : null;
                              const parsedHeaders = configHeaders
                                ? JSON.parse(configHeaders)
                                : {};

                              const res = await fetch("/api/routes", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                  apiName: selectedApi,
                                  method: route.method,
                                  path: route.path,
                                  status: statusNumber,
                                  headers: parsedHeaders,
                                  responseBody: parsedBody,
                                  proxyMode: configProxyModeType === "url",
                                  proxyUrl:
                                    configProxyModeType === "url"
                                      ? configProxyUrl.trim()
                                      : "",
                                  proxyToClient: configProxyModeType === "client",
                                  proxyClientId:
                                    configProxyModeType === "client"
                                      ? configProxyClientId
                                      : "",
                                  proxyServiceName:
                                    configProxyModeType === "client"
                                      ? configProxyServiceName
                                      : "",
                                  explicitlyConfigured: true,
                                  mockMode: "dynamic",
                                  dynamicRules:
                                    configProxyModeType === "disabled"
                                      ? dynamicRules
                                      : [],
                                }),
                              });

                              if (!res.ok) throw new Error(await res.text());

                              const nextOverrideMode =
                                configProxyModeType === "disabled"
                                  ? "mock"
                                  : configProxyModeType === "url"
                                    ? "url"
                                    : "client";
                              setRoutes((prev) =>
                                prev.map((r) =>
                                  r.id === route.id
                                    ? {
                                        ...r,
                                        overrideMode: nextOverrideMode,
                                        proxyClientId:
                                          nextOverrideMode === "client"
                                            ? configProxyClientId
                                            : undefined,
                                      }
                                    : r,
                                ),
                              );

                              setConfigMessage(
                                "Configuração salva. As próximas chamadas dessa rota usarão essa resposta.",
                              );
                            } catch (err) {
                              setConfigMessage(
                                err instanceof Error
                                  ? `Erro ao salvar configuração: ${err.message}`
                                  : "Erro ao salvar configuração",
                              );
                            }
                          }}
                        >
                          <div className="mb-2">
                            <span className="mb-1 block text-[11px] font-medium text-zinc-500">
                              Modo de resposta
                              {configProxyModeType !== null && apiHasProxy && (
                                <span className="ml-1.5 text-amber-600 dark:text-amber-400">
                                  — sobrescreve o proxy da API para esta rota
                                </span>
                              )}
                            </span>
                            <div className="flex flex-wrap gap-3">
                              {(
                                [
                                  ...(apiHasProxy ? (["api"] as const) : []),
                                  "disabled",
                                  "url",
                                  "client",
                                ] as const
                              ).map((mode) => {
                                const labels: Record<string, string> = {
                                  api: "Usar proxy da API",
                                  disabled: "Mock",
                                  url: "Proxy para URL",
                                  client: "Proxy para cliente conectado",
                                };
                                const isChecked =
                                  mode === "api"
                                    ? configProxyModeType === null
                                    : configProxyModeType === mode;
                                return (
                                  <label
                                    key={mode}
                                    className="inline-flex cursor-pointer items-center gap-1.5 text-[11px]"
                                  >
                                    <input
                                      type="radio"
                                      name="proxyModeType"
                                      className="h-3.5 w-3.5"
                                      checked={isChecked}
                                      onChange={() =>
                                        setConfigProxyModeType(
                                          mode === "api" ? null : mode,
                                        )
                                      }
                                    />
                                    <span>{labels[mode]}</span>
                                  </label>
                                );
                              })}
                            </div>
                          </div>

                          {configProxyModeType === null && apiHasProxy && (
                            <div className="mb-1 rounded border border-zinc-200 bg-white px-2 py-2 text-[11px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
                              Nenhum override configurado — esta rota usa o{" "}
                              <strong className="text-zinc-700 dark:text-zinc-300">
                                proxy da API
                              </strong>
                              . Selecione outro modo acima para sobrescrever o
                              comportamento desta rota específica.
                            </div>
                          )}

                          {configProxyModeType === "url" && (
                            <div className="mb-2 rounded border border-violet-200 bg-violet-50 p-2 dark:border-violet-900 dark:bg-violet-950/30">
                              <label className="flex flex-col gap-1">
                                <span className="text-[11px] font-medium text-violet-700 dark:text-violet-300">
                                  URL de destino
                                </span>
                                <input
                                  type="url"
                                  placeholder="https://api.exemplo.com/endpoint"
                                  className="h-7 rounded border border-zinc-300 bg-white px-2 font-mono text-[11px] text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                                  value={configProxyUrl}
                                  onChange={(e) => setConfigProxyUrl(e.target.value)}
                                />
                              </label>
                            </div>
                          )}

                          {configProxyModeType === "client" && (
                            <div className="mb-2 rounded border border-blue-200 bg-blue-50 p-2 dark:border-blue-900 dark:bg-blue-950/30">
                              <div className="mb-1 flex items-center gap-1">
                                <span className="text-[11px] font-medium text-blue-700 dark:text-blue-300">
                                  Cliente conectado
                                </span>
                                <span className="rounded bg-blue-200 px-1 py-0.5 text-[9px] font-medium text-blue-800 dark:bg-blue-800 dark:text-blue-200">
                                  via cliente
                                </span>
                              </div>
                              {connectedClients.filter((c) => c.status === "online").length ===
                              0 ? (
                                <div className="rounded bg-amber-100 px-2 py-1.5 text-[11px] text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
                                  Nenhum cliente online. Inicie um proxy-reverse agent.
                                </div>
                              ) : (
                                <div className="grid gap-2 sm:grid-cols-2">
                                  <label className="flex flex-col gap-1">
                                    <span className="text-[10px] text-blue-600 dark:text-blue-400">
                                      Cliente
                                    </span>
                                    <select
                                      className="h-7 rounded border border-zinc-300 bg-white px-2 text-[11px] dark:border-zinc-700 dark:bg-zinc-950"
                                      value={configProxyClientId}
                                      onChange={(e) => {
                                        setConfigProxyClientId(e.target.value);
                                        setConfigProxyServiceName("");
                                      }}
                                    >
                                      <option value="">Selecione um cliente</option>
                                      {connectedClients
                                        .filter((c) => c.status === "online")
                                        .map((client) => (
                                          <option
                                            key={client.clientId}
                                            value={client.clientId}
                                          >
                                            {client.clientName} (
                                            {client.localServices.length} serviços)
                                          </option>
                                        ))}
                                    </select>
                                  </label>
                                  <label className="flex flex-col gap-1">
                                    <span className="text-[10px] text-blue-600 dark:text-blue-400">
                                      Serviço
                                    </span>
                                    <select
                                      className="h-7 rounded border border-zinc-300 bg-white px-2 text-[11px] dark:border-zinc-700 dark:bg-zinc-950"
                                      value={configProxyServiceName}
                                      onChange={(e) =>
                                        setConfigProxyServiceName(e.target.value)
                                      }
                                      disabled={!configProxyClientId}
                                    >
                                      <option value="">Selecione um serviço</option>
                                      {connectedClients
                                        .find((c) => c.clientId === configProxyClientId)
                                        ?.localServices.map((service) => (
                                          <option key={service.name} value={service.name}>
                                            {service.name} ({service.host}:{service.port})
                                          </option>
                                        ))}
                                    </select>
                                  </label>
                                </div>
                              )}
                            </div>
                          )}

                          {configProxyModeType === "disabled" && (
                            <div className="mt-1 space-y-2">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[11px] font-medium text-zinc-500">
                                  Regras (primeira que bater ganha)
                                </span>
                              </div>
                              <button
                                type="button"
                                onClick={() => {
                                  const id = newDynamicRuleId();
                                  const rule: DynamicMockRule = {
                                    id,
                                    conditions: [emptyMockCondition()],
                                    joins: [],
                                    status: 200,
                                    body: { status: "ok" },
                                    headers: {},
                                  };
                                  setDynamicRules((prev) => [rule, ...prev]);
                                  setDraftDynamicRuleIds((prev) => [
                                    ...prev,
                                    conditionDraftKey(id, 0),
                                  ]);
                                  setExpandedDynamicRuleIds((prev) => [...prev, id]);
                                }}
                                className="flex w-full items-center justify-center rounded-md border border-dashed border-zinc-300 px-3 py-2 text-[11px] text-zinc-500 transition-colors hover:border-zinc-400 hover:text-zinc-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-200"
                              >
                                + Adicionar regra
                              </button>
                              {dynamicRules.map((rule, ruleIndex) => {
                                const expanded = expandedDynamicRuleIds.includes(rule.id);
                                const pathParams = listPathParamNames(route.path);
                                const draggedRuleIndex = draggingRuleId
                                  ? dynamicRules.findIndex((r) => r.id === draggingRuleId)
                                  : -1;
                                const showInsertBefore =
                                  draggingRuleId != null &&
                                  ruleDropIndex === ruleIndex &&
                                  ruleDropIndex !== draggedRuleIndex &&
                                  ruleDropIndex !== draggedRuleIndex + 1;
                                return (
                                  <div key={rule.id}>
                                    {showInsertBefore && (
                                      <div
                                        aria-hidden
                                        className="mb-1 h-0.5 rounded-full bg-orange-500"
                                      />
                                    )}
                                    <div
                                      data-dynamic-rule={rule.id}
                                      className={cn(
                                        "rounded border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950",
                                        draggingRuleId === rule.id && "opacity-40",
                                      )}
                                    >
                                      <div className="flex items-start gap-1.5 px-2 py-1.5">
                                        <button
                                          type="button"
                                          title="Arraste para reordenar"
                                          aria-label="Arrastar regra"
                                          onPointerDown={(e) =>
                                            beginDynamicRuleDrag(e, rule.id)
                                          }
                                          className="inline-flex h-8 w-4 shrink-0 cursor-grab touch-none items-center justify-center text-zinc-400 active:cursor-grabbing"
                                        >
                                          <svg
                                            aria-hidden
                                            viewBox="0 0 10 16"
                                            className="h-3.5 w-2.5"
                                            fill="currentColor"
                                          >
                                            <circle cx="3" cy="3" r="1.2" />
                                            <circle cx="7" cy="3" r="1.2" />
                                            <circle cx="3" cy="8" r="1.2" />
                                            <circle cx="7" cy="8" r="1.2" />
                                            <circle cx="3" cy="13" r="1.2" />
                                            <circle cx="7" cy="13" r="1.2" />
                                          </svg>
                                        </button>
                                        <div className="flex min-w-0 flex-1 flex-col gap-2">
                                          {rule.conditions.map((condition, condIndex) => (
                                            <div
                                              key={`${rule.id}-${condIndex}`}
                                              className="flex items-center gap-1"
                                            >
                                              {condIndex > 0 && (
                                                <div
                                                  role="group"
                                                  aria-label="Operador entre condições"
                                                  className="grid h-8 shrink-0 grid-cols-2 gap-0.5 rounded border border-zinc-300 bg-zinc-50 p-0.5 dark:border-zinc-700 dark:bg-zinc-900"
                                                >
                                                  {(["and", "or"] as const).map((op) => (
                                                    <button
                                                      key={op}
                                                      type="button"
                                                      aria-pressed={
                                                        (rule.joins[condIndex - 1] ??
                                                          "and") === op
                                                      }
                                                      onClick={() =>
                                                        setDynamicRules((prev) =>
                                                          prev.map((r) => {
                                                            if (r.id !== rule.id) return r;
                                                            const joins = [...r.joins];
                                                            joins[condIndex - 1] = op;
                                                            return { ...r, joins };
                                                          }),
                                                        )
                                                      }
                                                      className={cn(
                                                        "rounded px-1.5 text-[10px] font-semibold uppercase tracking-wide transition-colors",
                                                        (rule.joins[condIndex - 1] ??
                                                          "and") === op
                                                          ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-50"
                                                          : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200",
                                                      )}
                                                    >
                                                      {op}
                                                    </button>
                                                  ))}
                                                </div>
                                              )}
                                              <ConditionPillInput
                                                value={condition}
                                                pathParams={pathParams}
                                                draft={draftDynamicRuleIds.includes(
                                                  conditionDraftKey(rule.id, condIndex),
                                                )}
                                                onDraftConsumed={() =>
                                                  setDraftDynamicRuleIds((prev) =>
                                                    prev.filter(
                                                      (id) =>
                                                        id !==
                                                        conditionDraftKey(
                                                          rule.id,
                                                          condIndex,
                                                        ),
                                                    ),
                                                  )
                                                }
                                                onChange={(next) =>
                                                  setDynamicRules((prev) =>
                                                    prev.map((r) => {
                                                      if (r.id !== rule.id) return r;
                                                      const conditions = [
                                                        ...r.conditions,
                                                      ];
                                                      conditions[condIndex] = next;
                                                      return { ...r, conditions };
                                                    }),
                                                  )
                                                }
                                              />
                                              {rule.conditions.length > 1 && (
                                                <button
                                                  type="button"
                                                  title="Remover condição"
                                                  aria-label="Remover condição"
                                                  className="shrink-0 text-[10px] text-zinc-400 hover:text-red-500"
                                                  onClick={() => {
                                                    setDynamicRules((prev) =>
                                                      prev.map((r) => {
                                                        if (r.id !== rule.id) return r;
                                                        const conditions =
                                                          r.conditions.filter(
                                                            (_, i) => i !== condIndex,
                                                          );
                                                        const nextJoins: MockJoinOperator[] =
                                                          [];
                                                        for (
                                                          let i = 0;
                                                          i < conditions.length - 1;
                                                          i++
                                                        ) {
                                                          if (i < condIndex - 1) {
                                                            nextJoins.push(
                                                              r.joins[i] ?? "and",
                                                            );
                                                          } else if (i === condIndex - 1) {
                                                            nextJoins.push(
                                                              r.joins[condIndex - 1] ??
                                                                "and",
                                                            );
                                                          } else {
                                                            nextJoins.push(
                                                              r.joins[i + 1] ?? "and",
                                                            );
                                                          }
                                                        }
                                                        return {
                                                          ...r,
                                                          conditions,
                                                          joins: nextJoins,
                                                        };
                                                      }),
                                                    );
                                                    setDraftDynamicRuleIds((prev) =>
                                                      remapDraftKeysAfterRemove(
                                                        prev,
                                                        rule.id,
                                                        condIndex,
                                                      ),
                                                    );
                                                  }}
                                                >
                                                  ✕
                                                </button>
                                              )}
                                            </div>
                                          ))}
                                          <button
                                            type="button"
                                            className="self-start text-[10px] text-zinc-500 underline-offset-2 hover:text-zinc-800 hover:underline dark:hover:text-zinc-200"
                                            onClick={() => {
                                              const nextIndex = rule.conditions.length;
                                              setDynamicRules((prev) =>
                                                prev.map((r) =>
                                                  r.id === rule.id
                                                    ? {
                                                        ...r,
                                                        conditions: [
                                                          ...r.conditions,
                                                          emptyMockCondition(),
                                                        ],
                                                        joins: [...r.joins, "and"],
                                                      }
                                                    : r,
                                                ),
                                              );
                                              setDraftDynamicRuleIds((prev) => [
                                                ...prev,
                                                conditionDraftKey(rule.id, nextIndex),
                                              ]);
                                            }}
                                          >
                                            + Adicionar condição
                                          </button>
                                        </div>
                                        <button
                                          type="button"
                                          title={
                                            expanded
                                              ? "Ocultar resposta"
                                              : "Mostrar resposta"
                                          }
                                          aria-label={
                                            expanded
                                              ? "Ocultar resposta"
                                              : "Mostrar resposta"
                                          }
                                          className="inline-flex h-8 w-5 shrink-0 items-center justify-center text-[11px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                                          onClick={() =>
                                            setExpandedDynamicRuleIds((prev) =>
                                              prev.includes(rule.id)
                                                ? prev.filter((id) => id !== rule.id)
                                                : [...prev, rule.id],
                                            )
                                          }
                                        >
                                          {expanded ? "▼" : "▶"}
                                        </button>
                                        <button
                                          type="button"
                                          className="inline-flex h-8 shrink-0 items-center text-[10px] text-red-500"
                                          onClick={() => {
                                            setDynamicRules((prev) =>
                                              prev.filter((r) => r.id !== rule.id),
                                            );
                                            setDraftDynamicRuleIds((prev) =>
                                              prev.filter(
                                                (id) => !id.startsWith(`${rule.id}:`),
                                              ),
                                            );
                                          }}
                                        >
                                          ✕
                                        </button>
                                      </div>
                                    {expanded && (
                                      <div className="space-y-2 border-t border-zinc-100 px-2 py-2 dark:border-zinc-900">
                                        <div className="rounded border border-dashed border-zinc-200 p-2 dark:border-zinc-800">
                                          <span className="mb-1 block text-[10px] font-medium text-zinc-500">
                                            Resposta se a regra for verdadeira
                                          </span>
                                          <div className="mb-2 flex flex-wrap gap-2">
                                            <label className="flex items-center gap-1 text-[11px]">
                                              <span className="text-zinc-500">Status</span>
                                              <input
                                                type="number"
                                                min={100}
                                                max={599}
                                                className="h-6 w-16 rounded border border-zinc-300 bg-white px-1 font-mono text-[11px] dark:border-zinc-700 dark:bg-zinc-950"
                                                value={rule.status}
                                                onChange={(e) =>
                                                  setDynamicRules((prev) =>
                                                    prev.map((r) =>
                                                      r.id === rule.id
                                                        ? {
                                                            ...r,
                                                            status:
                                                              Number(e.target.value) ||
                                                              200,
                                                          }
                                                        : r,
                                                    ),
                                                  )
                                                }
                                              />
                                            </label>
                                          </div>
                                          <div className="flex flex-col gap-2">
                                            <HeadersEditor
                                              value={toFlatStringRecord(
                                                rule.headers ?? {},
                                              )}
                                              onChange={(next) =>
                                                setDynamicRules((prev) =>
                                                  prev.map((r) =>
                                                    r.id === rule.id
                                                      ? { ...r, headers: next }
                                                      : r,
                                                  ),
                                                )
                                              }
                                              defaultBodyMode={displayBodyMode}
                                              defaultJsonCollapsed={
                                                displayJsonCollapsed
                                              }
                                            />
                                            <JsonBodyEditor
                                              value={rule.body ?? {}}
                                              onChange={(next) =>
                                                setDynamicRules((prev) =>
                                                  prev.map((r) =>
                                                    r.id === rule.id
                                                      ? { ...r, body: next }
                                                      : r,
                                                  ),
                                                )
                                              }
                                              defaultBodyMode={displayBodyMode}
                                              defaultJsonCollapsed={
                                                displayJsonCollapsed
                                              }
                                            />
                                          </div>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                  </div>
                                );
                              })}
                              {draggingRuleId != null &&
                                ruleDropIndex === dynamicRules.length &&
                                ruleDropIndex !==
                                  dynamicRules.findIndex(
                                    (r) => r.id === draggingRuleId,
                                  ) &&
                                ruleDropIndex !==
                                  dynamicRules.findIndex(
                                    (r) => r.id === draggingRuleId,
                                  ) +
                                    1 && (
                                  <div
                                    aria-hidden
                                    className="h-0.5 rounded-full bg-orange-500"
                                  />
                                )}

                              <div className="space-y-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
                                <p className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
                                  Fallback (sem condições ou quando nenhuma bater)
                                </p>
                                <div className="flex flex-wrap gap-2">
                                  <label className="flex items-center gap-1 text-[11px]">
                                    <span className="text-zinc-500">Status</span>
                                    <input
                                      type="number"
                                      min={100}
                                      max={599}
                                      className="h-6 w-16 rounded border border-zinc-300 bg-white px-1 font-mono text-[11px] text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                                      value={configStatus}
                                      onChange={(e) => setConfigStatus(e.target.value)}
                                    />
                                  </label>
                                </div>
                                <div className="flex flex-col gap-2">
                                  <HeadersEditor
                                    value={toFlatStringRecord(
                                      safeParseJson(configHeaders || "{}"),
                                    )}
                                    onChange={(next) =>
                                      setConfigHeaders(
                                        JSON.stringify(next, null, 2),
                                      )
                                    }
                                    defaultBodyMode={displayBodyMode}
                                    defaultJsonCollapsed={displayJsonCollapsed}
                                  />
                                  <JsonBodyEditor
                                    value={safeParseJson(configBody || "{}")}
                                    onChange={(next) =>
                                      setConfigBody(
                                        JSON.stringify(next ?? {}, null, 2),
                                      )
                                    }
                                    defaultBodyMode={displayBodyMode}
                                    defaultJsonCollapsed={displayJsonCollapsed}
                                  />
                                </div>
                              </div>
                            </div>
                          )}

                          <div className="flex items-center justify-between gap-2">
                            <button
                              type="submit"
                              className="inline-flex items-center rounded bg-zinc-900 px-3 py-1 text-[11px] font-medium text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                            >
                              Salvar configuração
                            </button>
                            {configMessage && (
                              <span className="text-[11px] text-zinc-500">
                                {configMessage}
                              </span>
                            )}
                          </div>
                        </form>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {activeTab === "requests" && !loading && logs.length > 0 && (
            <div className="flex shrink-0 items-center justify-between gap-3 border-t border-zinc-200 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <span>
                Mostrando {logsPageStart}–{logsPageEnd} de {logs.length}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={safeLogsPage <= 1}
                  onClick={() => setLogsPage(safeLogsPage - 1)}
                  className="rounded border border-zinc-300 px-2 py-1 text-[11px] text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
                >
                  Anterior
                </button>
                <span className="tabular-nums">
                  Página {safeLogsPage} de {logsTotalPages}
                </span>
                <button
                  type="button"
                  disabled={safeLogsPage >= logsTotalPages}
                  onClick={() => setLogsPage(safeLogsPage + 1)}
                  className="rounded border border-zinc-300 px-2 py-1 text-[11px] text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
                >
                  Próxima
                </button>
              </div>
            </div>
          )}
          </>
          )}
        </section>
      </main>

      {/* Named path param modal */}
      {paramNameModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 px-4">
          <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-lg dark:bg-zinc-950">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
              Nome do parâmetro
            </h2>
            <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
              O segmento será convertido em um path param nomeado (ex.:{" "}
              <code className="font-mono">:id</code>).
            </p>
            <label className="mt-3 flex flex-col gap-1">
              <span className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
                Nome
              </span>
              <input
                autoFocus
                type="text"
                value={paramNameModal.paramName}
                onChange={(e) =>
                  setParamNameModal({
                    ...paramNameModal,
                    paramName: e.target.value,
                    error: null,
                  })
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void confirmParamNameModal();
                  }
                }}
                className="h-8 rounded border border-zinc-300 bg-white px-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-950"
                placeholder="id"
              />
            </label>
            {paramNameModal.error && (
              <p className="mt-2 text-[11px] text-red-600 dark:text-red-400">
                {paramNameModal.error}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setParamNameModal(null)}
                className="rounded border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void confirmParamNameModal()}
                className="rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                Continuar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Path param merge confirmation modal */}
      {wildcardModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 px-4">
          <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-lg dark:bg-zinc-950">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
              Converter para parâmetro?
            </h2>
            <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
              O segmento será convertido em{" "}
              <code className="rounded bg-zinc-100 px-1 font-mono text-[10px] dark:bg-zinc-900">
                {wildcardModal.newPath}
              </code>
              {wildcardModal.affectedRoutes.length > 0
                ? ". As rotas abaixo serão mescladas em uma única configuração."
                : "."}
            </p>
            <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto rounded border border-zinc-200 bg-zinc-50 p-2 text-[11px] dark:border-zinc-800 dark:bg-zinc-900">
              <li className="font-mono text-zinc-700 dark:text-zinc-300">
                {wildcardModal.route.method}{" "}
                {wildcardModal.route.path.split("/").filter(Boolean).join(" / ")}
              </li>
              {wildcardModal.affectedRoutes.map((r) => (
                <li key={r.id} className="font-mono text-zinc-600 dark:text-zinc-400">
                  {r.method} {r.path.split("/").filter(Boolean).join(" / ")}
                  {r.count > 0 && (
                    <span className="ml-1 text-zinc-400">({r.count} chamadas)</span>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs font-medium text-amber-700 dark:text-amber-300">
              {wildcardModal.affectedRoutes.length > 0
                ? "Essa ação é irreversível. Todas as configurações individuais serão substituídas por "
                : "A configuração desta rota passará a valer para qualquer valor neste segmento ("}
              <code className="font-mono">{wildcardModal.newPath}</code>
              {wildcardModal.affectedRoutes.length > 0 ? "." : ")."}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={wildcardConverting}
                onClick={() => setWildcardModal(null)}
                className="rounded border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={wildcardConverting}
                onClick={() =>
                  void convertToWildcard(
                    wildcardModal.route,
                    wildcardModal.newPath,
                    wildcardModal.affectedRoutes,
                  )
                }
                className="rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-50 hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                {wildcardConverting ? "Convertendo…" : "Confirmar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Server settings modal */}
      {settingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 px-4">
          <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg bg-white p-5 shadow-lg dark:bg-zinc-950">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                  Configurações do servidor
                </h2>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  Servidor:{" "}
                  <code className="font-mono text-zinc-700 dark:text-zinc-300">
                    {currentServerName}
                  </code>
                </p>
              </div>
              <button
                type="button"
                aria-label="Fechar"
                onClick={() => setSettingsOpen(false)}
                className="flex h-7 w-7 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-900 dark:hover:text-zinc-200"
              >
                ✕
              </button>
            </div>

            <div className="mt-5 flex flex-col gap-4">
              <section className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                <h3 className="text-xs font-semibold text-zinc-900 dark:text-zinc-50">
                  Segurança
                </h3>
                <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                  {settingsHasPassword
                    ? "Altere ou remova a senha de acesso deste servidor."
                    : "Defina uma senha para proteger o acesso a este servidor."}
                </p>

                <div className="mt-3 grid gap-2">
                  {settingsHasPassword && (
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
                        Senha atual
                      </span>
                      <input
                        type="password"
                        autoComplete="current-password"
                        value={settingsCurrentPassword}
                        onChange={(e) =>
                          setSettingsCurrentPassword(e.target.value)
                        }
                        className="h-8 rounded border border-zinc-300 bg-white px-2 text-xs text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                      />
                    </label>
                  )}
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
                      {settingsHasPassword ? "Nova senha" : "Senha"}
                    </span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={settingsNewPassword}
                      onChange={(e) => setSettingsNewPassword(e.target.value)}
                      className="h-8 rounded border border-zinc-300 bg-white px-2 text-xs text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
                      Confirmar senha
                    </span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={settingsConfirmPassword}
                      onChange={(e) =>
                        setSettingsConfirmPassword(e.target.value)
                      }
                      className="h-8 rounded border border-zinc-300 bg-white px-2 text-xs text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                    />
                  </label>
                </div>

                {settingsPasswordMessage && (
                  <p
                    className={cn(
                      "mt-2 text-[11px]",
                      settingsPasswordMessage.includes("Falha") ||
                        settingsPasswordMessage.includes("inválida") ||
                        settingsPasswordMessage.includes("não confere")
                        ? "text-red-600 dark:text-red-400"
                        : "text-emerald-600 dark:text-emerald-400",
                    )}
                  >
                    {settingsPasswordMessage}
                  </p>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={
                      settingsPasswordSaving ||
                      !settingsNewPassword.trim() ||
                      (settingsHasPassword && !settingsCurrentPassword)
                    }
                    onClick={() => void saveServerPassword(false)}
                    className="rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-50 hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                  >
                    {settingsPasswordSaving
                      ? "Salvando..."
                      : settingsHasPassword
                        ? "Alterar senha"
                        : "Definir senha"}
                  </button>
                  {settingsHasPassword && (
                    <button
                      type="button"
                      disabled={
                        settingsPasswordSaving || !settingsCurrentPassword
                      }
                      onClick={() => void saveServerPassword(true)}
                      className="rounded border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
                    >
                      Remover senha
                    </button>
                  )}
                </div>
              </section>

              <section className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                <h3 className="text-xs font-semibold text-zinc-900 dark:text-zinc-50">
                  Exibição
                </h3>
                <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                  Padrões para logs e editores de rota neste servidor.
                </p>

                <div className="mt-3 flex flex-col gap-4">
                  <div>
                    <p className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                      Formato padrão
                    </p>
                    <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                      Como Body e Headers abrem por padrão.
                    </p>
                    <div
                      role="group"
                      aria-label="Formato padrão"
                      className="mt-2 grid grid-cols-2 gap-1 rounded-md border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-700 dark:bg-zinc-900"
                    >
                      <button
                        type="button"
                        disabled={displaySettingsSaving}
                        aria-pressed={displayBodyMode === "table"}
                        onClick={() =>
                          void saveDisplaySettings({ displayBodyMode: "table" })
                        }
                        className={cn(
                          "rounded px-2 py-1.5 text-xs font-medium transition-colors disabled:opacity-60",
                          displayBodyMode === "table"
                            ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-50"
                            : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200",
                        )}
                      >
                        Table
                      </button>
                      <button
                        type="button"
                        disabled={displaySettingsSaving}
                        aria-pressed={displayBodyMode === "bulk"}
                        onClick={() =>
                          void saveDisplaySettings({ displayBodyMode: "bulk" })
                        }
                        className={cn(
                          "rounded px-2 py-1.5 text-xs font-medium transition-colors disabled:opacity-60",
                          displayBodyMode === "bulk"
                            ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-50"
                            : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200",
                        )}
                      >
                        Bulk
                      </button>
                    </div>
                  </div>

                  <div>
                    <p className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                      JSON aninhado
                    </p>
                    <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                      Objetos e arrays da raiz começam abertos ou colapsados.
                    </p>
                    <div
                      role="group"
                      aria-label="JSON aninhado"
                      className="mt-2 grid grid-cols-2 gap-1 rounded-md border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-700 dark:bg-zinc-900"
                    >
                      <button
                        type="button"
                        disabled={displaySettingsSaving}
                        aria-pressed={!displayJsonCollapsed}
                        onClick={() =>
                          void saveDisplaySettings({
                            displayJsonCollapsed: false,
                          })
                        }
                        className={cn(
                          "rounded px-2 py-1.5 text-xs font-medium transition-colors disabled:opacity-60",
                          !displayJsonCollapsed
                            ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-50"
                            : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200",
                        )}
                      >
                        Aberto
                      </button>
                      <button
                        type="button"
                        disabled={displaySettingsSaving}
                        aria-pressed={displayJsonCollapsed}
                        onClick={() =>
                          void saveDisplaySettings({
                            displayJsonCollapsed: true,
                          })
                        }
                        className={cn(
                          "rounded px-2 py-1.5 text-xs font-medium transition-colors disabled:opacity-60",
                          displayJsonCollapsed
                            ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-50"
                            : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200",
                        )}
                      >
                        Colapsado
                      </button>
                    </div>
                  </div>
                </div>
              </section>

              <section className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900/60 dark:bg-red-950/30">
                <h3 className="text-xs font-semibold text-red-700 dark:text-red-300">
                  Zona de perigo
                </h3>
                <p className="mt-1 text-[11px] text-red-700/90 dark:text-red-300/90">
                  Deletar o servidor remove permanentemente todas as APIs, rotas,
                  requisições e configurações de clients associados. Esta ação
                  não pode ser desfeita.
                </p>
                <label className="mt-3 flex flex-col gap-1">
                  <span className="text-[11px] font-medium text-red-700 dark:text-red-300">
                    Digite{" "}
                    <code className="font-mono">{currentServerName}</code> para
                    confirmar
                  </span>
                  <input
                    type="text"
                    value={settingsDeleteConfirm}
                    onChange={(e) => setSettingsDeleteConfirm(e.target.value)}
                    className="h-8 rounded border border-red-300 bg-white px-2 font-mono text-xs text-zinc-800 dark:border-red-900 dark:bg-zinc-950 dark:text-zinc-100"
                    placeholder={currentServerName}
                  />
                </label>
                {settingsDeleteError && (
                  <p className="mt-2 text-[11px] text-red-600 dark:text-red-400">
                    {settingsDeleteError}
                  </p>
                )}
                <button
                  type="button"
                  disabled={
                    settingsDeleting ||
                    settingsDeleteConfirm.trim().toLowerCase() !==
                      currentServerName.trim().toLowerCase()
                  }
                  onClick={() => void confirmDeleteServer()}
                  className="mt-3 rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-60 dark:bg-red-700 dark:hover:bg-red-600"
                >
                  {settingsDeleting ? "Deletando..." : "Deletar servidor"}
                </button>
              </section>
            </div>
          </div>
        </div>
      )}

      {/* Delete API confirmation modal */}
      {deleteApiName && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 px-4">
          <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-lg dark:bg-zinc-950">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
              Deletar API &quot;{deleteApiName}&quot;?
            </h2>
            <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
              Todas as configurações de proxy e rotas associadas a esta API serão removidas
              permanentemente. Esta ação não pode ser desfeita.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteApiName(null)}
                className="rounded border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void confirmDeleteApi()}
                className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600"
              >
                Deletar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete route confirmation modal */}
      {deleteRouteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 px-4">
          <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-lg dark:bg-zinc-950">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
              Deletar rota {deleteRouteTarget.method}{" "}
              <code className="font-mono text-[12px]">{deleteRouteTarget.path}</code>?
            </h2>
            <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
              A configuração desta rota será removida permanentemente. Esta ação não pode ser
              desfeita.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteRouteTarget(null)}
                className="rounded border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void confirmDeleteRoute()}
                className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600"
              >
                Deletar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clear requests confirmation modal */}
      {clearRequestsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 px-4">
          <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-lg dark:bg-zinc-950">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
              Limpar requisições da API &quot;{selectedApi}&quot;?
            </h2>
            <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
              Todas as {logs.length} requisições registradas serão removidas permanentemente.
              Esta ação não pode ser desfeita.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setClearRequestsOpen(false)}
                className="rounded border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void confirmClearRequests()}
                className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600"
              >
                Limpar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Export modal */}
      {exportOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 px-4">
          <div className="w-full max-w-md rounded-lg bg-white p-4 shadow-lg dark:bg-zinc-950">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                  Exportar configurações de rotas — API: {selectedApi}
                </h2>
                <p className="text-xs text-zinc-600 dark:text-zinc-400">
                  Escolha o formato de exportação.
                </p>
              </div>
              <button
                type="button"
                className="rounded-full p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-900"
                onClick={() => {
                  if (!exporting) setExportOpen(false);
                }}
              >
                ✕
              </button>
            </div>

            <div className="mb-3 space-y-2">
              {(
                [
                  {
                    value: "freeceptor" as ExportFormat,
                    title: "Freeceptor",
                    description: "Formato nativo com mocks, headers e configurações de proxy.",
                  },
                  {
                    value: "openapi-json" as ExportFormat,
                    title: "OpenAPI (JSON)",
                    description: "Especificação OpenAPI 3.0 em JSON.",
                  },
                  {
                    value: "openapi-yaml" as ExportFormat,
                    title: "OpenAPI (YAML)",
                    description: "Especificação OpenAPI 3.0 em YAML.",
                  },
                ] as const
              ).map((option) => (
                <label
                  key={option.value}
                  className={cn(
                    "flex cursor-pointer gap-3 rounded-md border px-3 py-2 transition-colors",
                    exportFormat === option.value
                      ? "border-zinc-900 bg-zinc-50 dark:border-zinc-200 dark:bg-zinc-900"
                      : "border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900",
                  )}
                >
                  <input
                    type="radio"
                    name="export-format"
                    value={option.value}
                    checked={exportFormat === option.value}
                    onChange={() => setExportFormat(option.value)}
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-xs font-medium text-zinc-900 dark:text-zinc-50">
                      {option.title}
                    </span>
                    <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">
                      {option.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>

            {exportError && (
              <div className="mb-2 rounded-md bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-200">
                {exportError}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded border border-zinc-300 px-3 py-1 text-[11px] text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
                onClick={() => {
                  if (!exporting) setExportOpen(false);
                }}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="inline-flex items-center rounded bg-zinc-900 px-3 py-1 text-[11px] font-medium text-zinc-50 hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                disabled={exporting}
                onClick={() => void handleExport()}
              >
                {exporting ? "Exportando..." : "Exportar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import modal */}
      {importOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 px-4">
          <div className="w-full max-w-xl rounded-lg bg-white p-4 shadow-lg dark:bg-zinc-950">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                  Importar configurações de rotas — API: {selectedApi}
                </h2>
                <p className="text-xs text-zinc-600 dark:text-zinc-400">
                  Arraste um arquivo{" "}
                  <code className="mx-1 rounded bg-zinc-100 px-1 py-[1px] font-mono text-[10px] dark:bg-zinc-900">
                    .json
                  </code>
                  ,{" "}
                  <code className="mx-1 rounded bg-zinc-100 px-1 py-[1px] font-mono text-[10px] dark:bg-zinc-900">
                    .yaml
                  </code>{" "}
                  ou{" "}
                  <code className="mx-1 rounded bg-zinc-100 px-1 py-[1px] font-mono text-[10px] dark:bg-zinc-900">
                    .yml
                  </code>{" "}
                  (Freeceptor ou OpenAPI) ou procure no computador.
                </p>
              </div>
              <button
                type="button"
                className="rounded-full p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-900"
                onClick={() => {
                  if (!importing) setImportOpen(false);
                }}
              >
                ✕
              </button>
            </div>

            <div className="mb-3 grid gap-3 md:grid-cols-2">
              <div
                className="flex h-56 cursor-default flex-col items-center justify-center rounded-md border border-dashed border-zinc-300 bg-zinc-50 px-3 py-2 text-center text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                onDragOver={(e) => e.preventDefault()}
                onDrop={async (e) => {
                  e.preventDefault();
                  try {
                    setImportError(null);
                    if (e.dataTransfer.files?.[0]) {
                      await readImportFile(e.dataTransfer.files[0]);
                    }
                  } catch (err) {
                    setImportDetected(null);
                    setImportError(
                      err instanceof Error ? err.message : "Arquivo inválido.",
                    );
                  }
                }}
              >
                <span className="mb-2 text-2xl leading-none">↑</span>
                <span className="text-[11px] font-medium">
                  Arraste um arquivo aqui
                </span>
              </div>
              <button
                type="button"
                className="flex h-56 cursor-pointer flex-col items-center justify-center rounded-md border border-dashed border-zinc-300 bg-zinc-50 px-3 py-2 text-center text-xs text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
                onClick={() => importFileInputRef.current?.click()}
              >
                <span className="mb-2 text-2xl leading-none">⌕</span>
                <span className="text-[11px] font-medium">
                  Clique para selecionar do computador
                </span>
              </button>
              <input
                ref={importFileInputRef}
                type="file"
                accept=".json,.yaml,.yml,application/json,application/x-yaml,text/yaml"
                className="hidden"
                onChange={async (e) => {
                  try {
                    setImportError(null);
                    const file = e.target.files?.[0];
                    if (!file) return;
                    await readImportFile(file);
                  } catch (err) {
                    setImportDetected(null);
                    setImportError(
                      err instanceof Error ? err.message : "Arquivo inválido.",
                    );
                  } finally {
                    if (importFileInputRef.current) {
                      importFileInputRef.current.value = "";
                    }
                  }
                }}
              />
            </div>

            {importFileName && (
              <div className="mb-2 rounded-md bg-zinc-100 px-3 py-1.5 text-xs text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
                Arquivo: <span className="font-mono">{importFileName}</span>
                {importDetected && (
                  <span className="ml-2 inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-800 dark:bg-blue-900/40 dark:text-blue-200">
                    Detectado: {importDetected.label} — {importDetected.routeCount}{" "}
                    {importDetected.routeCount === 1 ? "rota" : "rotas"}
                  </span>
                )}
              </div>
            )}

            {importDetected?.format === "openapi" && (
              <div className="mb-2 rounded-md bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                Rotas OpenAPI sem example usarão body vazio. Parâmetros de path serão
                convertidos para params nomeados (:id).
              </div>
            )}

            {importError && (
              <div className="mb-2 rounded-md bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-200">
                {importError}
              </div>
            )}

            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-zinc-500">
                As rotas importadas serão mescladas às existentes.
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="rounded border border-zinc-300 px-3 py-1 text-[11px] text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
                  onClick={() => {
                    if (!importing) setImportOpen(false);
                  }}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="inline-flex items-center rounded bg-zinc-900 px-3 py-1 text-[11px] font-medium text-zinc-50 hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                  disabled={importing}
                  onClick={async () => {
                    try {
                      setImportError(null);
                      setImporting(true);
                      if (!importText.trim()) {
                        throw new Error("Selecione um arquivo primeiro.");
                      }
                      const parsed = JSON.parse(importText) as unknown;
                      const detected =
                        importDetected ?? analyzeImportFile(parsed, selectedApi);
                      const configs = routeConfigsFromImport(
                        parsed,
                        detected.format,
                        selectedApi,
                      );
                      if (configs.length === 0) {
                        throw new Error("Nenhuma rota encontrada no arquivo.");
                      }
                      await persistRouteConfigs(configs);
                      setImportOpen(false);
                    } catch (err) {
                      setImportError(
                        err instanceof Error ? err.message : "Erro ao importar configs.",
                      );
                    } finally {
                      setImporting(false);
                    }
                  }}
                >
                  {importing ? "Importando..." : "Importar"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* API proxy config modal */}
      {apiConfigOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 px-4">
          <div className="w-full max-w-lg rounded-lg bg-white p-4 shadow-lg dark:bg-zinc-950">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                  Proxy da API &quot;{selectedApi}&quot;
                </h2>
                <p className="text-xs text-zinc-600 dark:text-zinc-400">
                  Configurado aqui, aplica-se a todas as rotas desta API. Rotas com proxy próprio têm prioridade.
                </p>
              </div>
              <button
                type="button"
                className="rounded-full p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-900"
                onClick={() => setApiConfigOpen(false)}
              >
                ✕
              </button>
            </div>

            <form
              className="flex flex-col gap-3"
              onSubmit={async (e) => {
                e.preventDefault();
                setApiConfigMessage(null);
                setApiConfigSaving(true);
                try {
                  if (apiProxyModeType === "url" && !apiProxyUrl.trim()) {
                    throw new Error("Informe a URL do proxy.");
                  }
                  if (apiProxyModeType === "client") {
                    if (!apiProxyClientId) throw new Error("Selecione um cliente.");
                    if (!apiProxyServiceName) throw new Error("Selecione um serviço.");
                  }

                  const res = await fetch("/api/apis", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      apiName: selectedApi,
                      proxyMode: apiProxyModeType === "url",
                      proxyUrl: apiProxyModeType === "url" ? apiProxyUrl.trim() : "",
                      proxyToClient: apiProxyModeType === "client",
                      proxyClientId:
                        apiProxyModeType === "client" ? apiProxyClientId : "",
                      proxyServiceName:
                        apiProxyModeType === "client" ? apiProxyServiceName : "",
                    }),
                  });
                  if (!res.ok) throw new Error(await res.text());

                  await loadApiList();
                  setApiConfigMessage("Configuração salva.");
                } catch (err) {
                  setApiConfigMessage(
                    err instanceof Error
                      ? `Erro: ${err.message}`
                      : "Erro ao salvar.",
                  );
                } finally {
                  setApiConfigSaving(false);
                }
              }}
            >
              <div>
                <span className="mb-1 block text-[11px] font-medium text-zinc-500">
                  Modo de proxy
                </span>
                <div className="flex flex-wrap gap-3">
                  <label className="inline-flex items-center gap-1.5 text-[11px]">
                    <input
                      type="radio"
                      name="apiProxyMode"
                      className="h-3.5 w-3.5"
                      checked={apiProxyModeType === "disabled"}
                      onChange={() => setApiProxyModeType("disabled")}
                    />
                    <span>Desabilitado</span>
                  </label>
                  <label className="inline-flex items-center gap-1.5 text-[11px]">
                    <input
                      type="radio"
                      name="apiProxyMode"
                      className="h-3.5 w-3.5"
                      checked={apiProxyModeType === "url"}
                      onChange={() => setApiProxyModeType("url")}
                    />
                    <span>Proxy para URL</span>
                  </label>
                  <label className="inline-flex items-center gap-1.5 text-[11px]">
                    <input
                      type="radio"
                      name="apiProxyMode"
                      className="h-3.5 w-3.5"
                      checked={apiProxyModeType === "client"}
                      onChange={() => setApiProxyModeType("client")}
                    />
                    <span>Proxy para cliente conectado</span>
                  </label>
                </div>
              </div>

              {apiProxyModeType === "url" && (
                <div className="rounded border border-violet-200 bg-violet-50 p-2 dark:border-violet-900 dark:bg-violet-950/30">
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] font-medium text-violet-700 dark:text-violet-300">
                      URL de destino
                    </span>
                    <input
                      type="url"
                      placeholder="https://api.exemplo.com"
                      className="h-7 rounded border border-zinc-300 bg-white px-2 font-mono text-[11px] text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                      value={apiProxyUrl}
                      onChange={(e) => setApiProxyUrl(e.target.value)}
                    />
                  </label>
                </div>
              )}

              {apiProxyModeType === "client" && (
                <div className="rounded border border-blue-200 bg-blue-50 p-2 dark:border-blue-900 dark:bg-blue-950/30">
                  <div className="mb-1 flex items-center gap-1">
                    <span className="text-[11px] font-medium text-blue-700 dark:text-blue-300">
                      Cliente conectado
                    </span>
                  </div>
                  {connectedClients.filter((c) => c.status === "online").length === 0 ? (
                    <div className="rounded bg-amber-100 px-2 py-1.5 text-[11px] text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
                      Nenhum cliente online.
                    </div>
                  ) : (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <label className="flex flex-col gap-1">
                        <span className="text-[10px] text-blue-600 dark:text-blue-400">
                          Cliente
                        </span>
                        <select
                          className="h-7 rounded border border-zinc-300 bg-white px-2 text-[11px] dark:border-zinc-700 dark:bg-zinc-950"
                          value={apiProxyClientId}
                          onChange={(e) => {
                            setApiProxyClientId(e.target.value);
                            setApiProxyServiceName("");
                          }}
                        >
                          <option value="">Selecione um cliente</option>
                          {connectedClients
                            .filter((c) => c.status === "online")
                            .map((client) => (
                              <option key={client.clientId} value={client.clientId}>
                                {client.clientName}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-[10px] text-blue-600 dark:text-blue-400">
                          Serviço
                        </span>
                        <select
                          className="h-7 rounded border border-zinc-300 bg-white px-2 text-[11px] dark:border-zinc-700 dark:bg-zinc-950"
                          value={apiProxyServiceName}
                          onChange={(e) => setApiProxyServiceName(e.target.value)}
                          disabled={!apiProxyClientId}
                        >
                          <option value="">Selecione um serviço</option>
                          {connectedClients
                            .find((c) => c.clientId === apiProxyClientId)
                            ?.localServices.map((service) => (
                              <option key={service.name} value={service.name}>
                                {service.name} ({service.host}:{service.port})
                              </option>
                            ))}
                        </select>
                      </label>
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-center justify-between gap-2">
                <button
                  type="submit"
                  disabled={apiConfigSaving}
                  className="inline-flex items-center rounded bg-zinc-900 px-3 py-1 text-[11px] font-medium text-zinc-50 hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                >
                  {apiConfigSaving ? "Salvando..." : "Salvar"}
                </button>
                {apiConfigMessage && (
                  <span className="text-[11px] text-zinc-500">{apiConfigMessage}</span>
                )}
              </div>
            </form>
          </div>
        </div>
      )}

      {dragGhost && (
        <div
          ref={dragGhostRef}
          aria-hidden
          className="pointer-events-none fixed left-0 top-0 z-[100] will-change-transform"
          style={{
            width: dragGhost.width,
            height: dragGhost.height,
            transform: `translate3d(${dragGhost.left}px, ${dragGhost.top}px, 0)`,
          }}
        >
          <div
            className={cn(
              "inline-flex h-full w-full items-center gap-1.5 rounded-full py-1 pl-2 pr-3 text-[11px] font-medium shadow-lg ring-1 ring-black/10 dark:ring-white/10",
              dragGhost.selected
                ? "bg-zinc-900 text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                : "border border-zinc-300 bg-white text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300",
            )}
          >
            <svg
              aria-hidden
              viewBox="0 0 10 16"
              className="h-3.5 w-2.5 shrink-0 text-zinc-400 opacity-50"
              fill="currentColor"
            >
              <circle cx="3" cy="3" r="1.2" />
              <circle cx="7" cy="3" r="1.2" />
              <circle cx="3" cy="8" r="1.2" />
              <circle cx="7" cy="8" r="1.2" />
              <circle cx="3" cy="13" r="1.2" />
              <circle cx="7" cy="13" r="1.2" />
            </svg>
            {!dragGhost.selected && dragGhost.unread > 0 && (
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-orange-500 px-1 text-[9px] font-semibold leading-none text-white">
                {dragGhost.unread > 99 ? "99+" : dragGhost.unread}
              </span>
            )}
            {dragGhost.apiName}
            {dragGhost.proxyToClient ? (
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-500" />
            ) : dragGhost.proxyMode ? (
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-violet-500" />
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
