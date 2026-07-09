import { NextRequest, NextResponse } from "next/server";
import {
  getPendingRequests,
  updateHeartbeat,
} from "@/lib/server/proxy-clients";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const clientId = searchParams.get("clientId");
    const serverName = searchParams.get("serverName");

    if (!clientId || !serverName) {
      return NextResponse.json(
        { error: "clientId and serverName are required" },
        { status: 400 }
      );
    }

    await updateHeartbeat(serverName, clientId);

    const commands = await getPendingRequests(serverName, clientId);

    return NextResponse.json({
      commands,
    });
  } catch (err) {
    console.error("Error getting pending commands:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
