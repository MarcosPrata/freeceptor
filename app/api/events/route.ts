import { NextResponse } from "next/server";
import {
  getSnapshot,
  subscribeToChanges,
  subscribeToServerActivity,
} from "@/lib/server/request-log";
import { getServerFromCookie } from "@/lib/server/server-session";
import { getMergedClientsByServer } from "@/lib/server/proxy-clients";
import { clientManager } from "@/lib/server/websocket";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const serverName = getServerFromCookie(request);
  if (!serverName) {
    return NextResponse.json(
      { error: "server não autenticado." },
      { status: 401 },
    );
  }

  const url = new URL(request.url);
  const apiName = url.searchParams.get("apiName") || "default";

  const { signal } = request;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      function send(data: unknown) {
        if (closed) return;
        const json = JSON.stringify(data);
        controller.enqueue(encoder.encode(`data: ${json}\n\n`));
      }

      function sendRetryHint(ms: number) {
        if (closed) return;
        controller.enqueue(encoder.encode(`retry: ${ms}\n\n`));
      }

      function sendHeartbeat() {
        if (closed) return;
        // Send as a real data event (not a comment) so browsers reset their connection timer.
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "heartbeat" })}\n\n`));
      }

      sendRetryHint(3000);
      const snapshot = await getSnapshot(serverName, apiName);
      send({
        type: "snapshot",
        ...snapshot,
        clients: await getMergedClientsByServer(serverName),
      });

      const unsubscribe = subscribeToChanges(serverName, apiName, (payload) => {
        send({ type: "update", ...payload });
      });

      const unsubscribeActivity = subscribeToServerActivity(
        serverName,
        (activeApiName) => {
          send({ type: "api_activity", apiName: activeApiName });
        },
      );

      const unsubscribeClients = clientManager.onClientUpdate((updatedServer) => {
        if (updatedServer !== serverName) return;
        void getMergedClientsByServer(serverName).then((clients) => {
          send({ type: "clients", clients });
        });
      });

      const heartbeatId = setInterval(() => {
        sendHeartbeat();
      }, 15000);

      function closeStream() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeatId);
        unsubscribe();
        unsubscribeActivity();
        unsubscribeClients();
        controller.close();
      }

      signal.addEventListener("abort", () => {
        closeStream();
      });
    },
    cancel() {
      // nada especial
    },
  });

  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
