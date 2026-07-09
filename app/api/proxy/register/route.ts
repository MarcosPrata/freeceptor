import { NextRequest, NextResponse } from "next/server";
import { registerProxyClient } from "@/lib/server/proxy-clients";
import { verifyOrCreateServerConfig } from "@/lib/server/server-config";
import type { ProxyServiceInfo } from "@/types/proxy-client";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      clientId,
      clientName,
      serverName,
      password,
      localServices,
    } = body as {
      clientId: string;
      clientName: string;
      serverName: string;
      password?: string;
      localServices: ProxyServiceInfo[];
    };

    if (!clientId || !serverName) {
      return NextResponse.json(
        { error: "clientId and serverName are required" },
        { status: 400 }
      );
    }

    const serverResult = await verifyOrCreateServerConfig(serverName, password);
    if (!serverResult.ok) {
      return NextResponse.json(
        { error: serverResult.message || "Invalid server credentials" },
        { status: 401 }
      );
    }

    const client = await registerProxyClient(
      serverName,
      clientId,
      clientName || clientId,
      localServices || []
    );

    return NextResponse.json({
      success: true,
      client,
    });
  } catch (err) {
    console.error("Error registering proxy client:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
