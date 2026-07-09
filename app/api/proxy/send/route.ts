import { NextRequest, NextResponse } from "next/server";
import {
  sendRequestToClient,
  getRequestResponse,
  getProxyClient,
} from "@/lib/server/proxy-clients";
import { getServerSession } from "@/lib/server/server-session";

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

    const client = await getProxyClient(session.serverName, targetClientId);
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

    const requestId = await sendRequestToClient(
      session.serverName,
      targetClientId,
      serviceName,
      method,
      path,
      headers ?? {},
      requestBody ?? null
    );

    if (!waitForResponse) {
      return NextResponse.json({
        requestId,
        status: "pending",
      });
    }

    const response = await getRequestResponse(requestId, timeoutMs ?? 30000);

    if (!response) {
      return NextResponse.json({
        requestId,
        status: "timeout",
        error: "Request timed out waiting for response",
      });
    }

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
  } catch (err) {
    console.error("Error sending request to client:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
