import { NextResponse } from "next/server";
import { getServerFromCookie } from "@/lib/server/server-session";

export async function GET(request: Request) {
  const serverName = getServerFromCookie(request);
  if (!serverName) {
    return NextResponse.json({ authenticated: false });
  }
  return NextResponse.json({
    authenticated: true,
    serverName,
  });
}
