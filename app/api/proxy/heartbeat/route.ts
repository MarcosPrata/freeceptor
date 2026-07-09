import { NextRequest, NextResponse } from "next/server";
import { updateHeartbeat } from "@/lib/server/proxy-clients";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { clientId, serverName } = body as {
      clientId: string;
      serverName: string;
    };

    if (!clientId || !serverName) {
      return NextResponse.json(
        { error: "clientId and serverName are required" },
        { status: 400 }
      );
    }

    const updated = await updateHeartbeat(serverName, clientId);

    if (!updated) {
      return NextResponse.json(
        { error: "Client not found. Please register first." },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Error updating heartbeat:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
