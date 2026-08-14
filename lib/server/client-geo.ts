/**
 * Caller identity for the request log and live SSE rows.
 * IP comes from the incoming proxy headers; city/country from ip-api (cached).
 */

export type ClientGeo = {
  ip: string;
  label: string;
};

const GEO_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, { label: string; at: number }>();

function headerValue(
  headers: Headers | Record<string, string>,
  name: string,
): string | null {
  if (headers instanceof Headers) return headers.get(name);
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

function normalizeIp(raw: string): string {
  let ip = raw.trim();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  return ip;
}

export function isPrivateIp(ip: string): boolean {
  if (!ip || ip === "unknown") return true;
  if (ip === "::1" || ip === "127.0.0.1") return true;
  if (ip.startsWith("10.") || ip.startsWith("192.168.") || ip.startsWith("127.")) {
    return true;
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80:")) {
    return true;
  }
  return false;
}

export function extractClientIp(headers: Headers | Record<string, string>): string {
  const forwarded =
    headerValue(headers, "cf-connecting-ip") ??
    headerValue(headers, "true-client-ip") ??
    headerValue(headers, "x-real-ip") ??
    headerValue(headers, "x-forwarded-for");
  if (!forwarded) return "unknown";
  const first = forwarded.split(",")[0] ?? "";
  return normalizeIp(first) || "unknown";
}

export function formatCallerLabel(ip?: string, geo?: string): string {
  if (!ip || ip === "unknown") return geo?.trim() || "";
  if (!geo?.trim()) return ip;
  return `${ip} · ${geo}`;
}

export async function resolveClientGeo(ip: string): Promise<ClientGeo> {
  if (!ip || ip === "unknown") return { ip: ip || "unknown", label: "" };
  if (isPrivateIp(ip)) return { ip, label: "rede local" };

  const cached = cache.get(ip);
  if (cached && Date.now() - cached.at < GEO_TTL_MS) {
    return { ip, label: cached.label };
  }

  try {
    const url = `https://ipwho.is/${encodeURIComponent(ip)}?fields=success,city,country_code`;
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { ip, label: "" };
    const data = (await res.json()) as {
      success?: boolean;
      city?: string;
      country_code?: string;
    };
    if (data.success === false) {
      cache.set(ip, { label: "", at: Date.now() });
      return { ip, label: "" };
    }
    const label = [data.city, data.country_code].filter(Boolean).join(", ");
    cache.set(ip, { label, at: Date.now() });
    return { ip, label };
  } catch {
    return { ip, label: "" };
  }
}
