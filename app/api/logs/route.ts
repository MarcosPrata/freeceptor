import { NextResponse } from "next/server";
import { getRequestLogs } from "@/lib/server/request-log";

export async function GET() {
  const logs = getRequestLogs();
  return NextResponse.json(logs);
}

