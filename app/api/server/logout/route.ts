import { NextResponse } from "next/server";
import { SERVER_COOKIE_NAME } from "@/lib/server/server-session";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: SERVER_COOKIE_NAME,
    value: "",
    path: "/",
    maxAge: 0,
  });
  return response;
}
