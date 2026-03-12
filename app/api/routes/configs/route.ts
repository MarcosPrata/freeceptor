import { NextResponse } from "next/server";
import { getAllRouteConfigs } from "@/lib/server/request-log";

export async function GET() {
  const configs = getAllRouteConfigs();
  return NextResponse.json(configs);
}

