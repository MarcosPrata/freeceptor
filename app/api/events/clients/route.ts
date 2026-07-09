import { NextResponse } from "next/server";
import { getServerSession } from "@/lib/server/server-session";
import { clientManager } from "@/lib/server/websocket";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await getServerSession();
  if (!session.authenticated || !session.serverName) {
    return NextResponse.json({ error: "server não autenticado." }, { status: 401 });
  }

  const { serverName } = session;
  const { signal } = request;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      function send(data: unknown) {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      }

      function sendHeartbeat() {
        if (closed) return;
        controller.enqueue(encoder.encode(": heartbeat\n\n"));
      }

      function closeStream() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeatId);
        unsubscribe();
        controller.close();
      }

      // snapshot inicial
      controller.enqueue(encoder.encode("retry: 3000\n\n"));
      send({ clients: clientManager.getClientsByServer(serverName) });

      // assina mudanças de clientes
      const unsubscribe = clientManager.onClientUpdate((updatedServer) => {
        if (updatedServer !== serverName) return;
        send({ clients: clientManager.getClientsByServer(serverName) });
      });

      const heartbeatId = setInterval(sendHeartbeat, 15000);

      signal.addEventListener("abort", closeStream);
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
