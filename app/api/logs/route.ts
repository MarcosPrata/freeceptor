import { NextResponse } from "next/server";
import { getRequestLogs, clearRequestLogs } from "@/lib/server/request-log";

export async function GET() {
  const logs = getRequestLogs();
  return NextResponse.json(logs);
}

export async function DELETE() {
  clearRequestLogs();
  return NextResponse.json({ ok: true });
}

