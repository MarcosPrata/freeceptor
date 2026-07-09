import { NextRequest, NextResponse } from "next/server";
import { listProxyClients, getProxyClient } from "@/lib/server/proxy-clients";
import { getServerSession } from "@/lib/server/server-session";

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession();

    if (!session.authenticated || !session.serverName) {
      return NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const clientId = searchParams.get("clientId");

    if (clientId) {
      const client = await getProxyClient(session.serverName, clientId);
      if (!client) {
        return NextResponse.json(
          { error: "Client not found" },
          { status: 404 }
        );
      }
      return NextResponse.json({ client });
    }

    const clients = await listProxyClients(session.serverName);

    return NextResponse.json({
      clients,
    });
  } catch (err) {
    console.error("Error listing proxy clients:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
