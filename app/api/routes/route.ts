import { NextResponse } from "next/server";
import { getRouteStats } from "@/lib/server/request-log";

export async function GET() {
  const routes = getRouteStats();
  return NextResponse.json(routes);
}

