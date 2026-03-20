import { NextResponse } from "next/server";
import { getRequestLogs, clearRequestLogs } from "@/lib/server/request-log";

export async function GET() {
  const logs = await getRequestLogs();
  return NextResponse.json(logs);
}

export async function DELETE() {
  await clearRequestLogs();
  return NextResponse.json({ ok: true });
}

