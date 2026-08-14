import { cookies } from "next/headers";

export const SERVER_COOKIE_NAME = "freeceptor_server";
export const DEFAULT_SERVER_NAME = "default";

function parseCookieHeader(cookieHeader: string | null): Record<string, string> {
  if (!cookieHeader) return {};
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, part) => {
      const idx = part.indexOf("=");
      if (idx <= 0) return acc;
      const key = decodeURIComponent(part.slice(0, idx).trim());
      const value = decodeURIComponent(part.slice(idx + 1).trim());
      acc[key] = value;
      return acc;
    }, {});
}

export function getServerFromCookie(request: Request): string | undefined {
  const cookieMap = parseCookieHeader(request.headers.get("cookie"));
  const value = cookieMap[SERVER_COOKIE_NAME]?.trim();
  return value || undefined;
}

export async function getServerSession(): Promise<{
  authenticated: boolean;
  serverName: string | null;
}> {
  const cookieStore = await cookies();
  const serverName = cookieStore.get(SERVER_COOKIE_NAME)?.value?.trim() || null;
  return {
    authenticated: !!serverName,
    serverName,
  };
}

export function resolveServerNameForIncomingRequest(request: Request): string {
  const url = new URL(request.url);
  const headerServer = request.headers.get("x-freeceptor-server")?.trim();
  const queryServer = url.searchParams.get("__server")?.trim();
  const cookieServer = getServerFromCookie(request);
  return headerServer || queryServer || cookieServer || DEFAULT_SERVER_NAME;
}
