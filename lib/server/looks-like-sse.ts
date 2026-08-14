/**
 * Detects an SSE client so the proxy can stream instead of buffering until
 * `end`. Unary buffering + a 25–30 s timeout is why `GET /economy/events`
 * never delivered `heartbeat` / `gems_credited` through the tunnel.
 */
export function looksLikeSseRequest(
  method: string,
  path: string,
  headers: Record<string, string>,
): boolean {
  if (method.toUpperCase() !== "GET") return false;

  const accept = headerValue(headers, "accept").toLowerCase();
  if (accept.includes("text/event-stream")) return true;

  const pathname = path.split("?")[0] ?? "";
  return /\/events(\/|$)/i.test(pathname);
}

export function headerValue(
  headers: Record<string, string>,
  name: string,
): string {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === lower) return value;
  }
  return "";
}
