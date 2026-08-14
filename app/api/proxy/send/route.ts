import { NextRequest, NextResponse } from "next/server";
import { getMergedClient, getMergedClientsByServer } from "@/lib/server/proxy-clients";
import { clientManager } from "@/lib/server/websocket";
import type { RequestMessage } from "@/lib/server/websocket";
import { getServerSession } from "@/lib/server/server-session";

function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession();

    if (!session.authenticated || !session.serverName) {
      return NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      );
    }

    const body = await request.json();
    const {
      targetClientId,
      serviceName,
      method,
      path,
      headers,
      body: requestBody,
      waitForResponse,
      timeoutMs,
    } = body as {
      targetClientId: string;
      serviceName: string;
      method: string;
      path: string;
      headers?: Record<string, string>;
      body?: unknown;
      waitForResponse?: boolean;
      timeoutMs?: number;
    };

    if (!targetClientId || !serviceName || !method || !path) {
      return NextResponse.json(
        { error: "targetClientId, serviceName, method, and path are required" },
        { status: 400 }
      );
    }

    const clients = await getMergedClientsByServer(session.serverName);
    const client = clients.find((c) => c.clientId === targetClientId);
    
    if (!client) {
      return NextResponse.json(
        { error: "Target client not found" },
        { status: 404 }
      );
    }

    if (client.status !== "online") {
      return NextResponse.json(
        { error: "Target client is offline" },
        { status: 503 }
      );
    }

    const serviceExists = client.localServices.some(
      (s) => s.name === serviceName
    );
    if (!serviceExists) {
      return NextResponse.json(
        {
          error: `Service "${serviceName}" not available on target client`,
          availableServices: client.localServices.map((s) => s.name),
        },
        { status: 404 }
      );
    }

    const requestId = generateRequestId();

    const requestMessage: RequestMessage = {
      type: "request",
      requestId,
      targetClientId,
      serviceName,
      method,
      path,
      headers: headers ?? {},
      body: requestBody ?? null,
    };

    const sent = clientManager.sendToClient(
      session.serverName,
      targetClientId,
      requestMessage
    );

    if (!sent) {
      return NextResponse.json(
        { error: "Failed to send request to client" },
        { status: 503 }
      );
    }

    if (!waitForResponse) {
      return NextResponse.json({
        requestId,
        status: "pending",
      });
    }

    try {
      const response = await clientManager.registerPendingRequest(
        requestId,
        timeoutMs ?? 30000
      );

      return NextResponse.json({
        requestId,
        status: "completed",
        response: {
          status: response.status,
          headers: response.headers,
          body: response.body,
          error: response.error,
        },
      });
    } catch {
      return NextResponse.json({
        requestId,
        status: "timeout",
        error: "Request timed out waiting for response",
      });
    }
  } catch (err) {
    console.error("Error sending request to client:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
