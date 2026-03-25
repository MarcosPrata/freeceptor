import { NextResponse } from "next/server";
import {
  getSnapshot,
  subscribeToChanges,
} from "@/lib/server/request-log";
import { getServerFromCookie } from "@/lib/server/server-session";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const serverName = getServerFromCookie(request);
  if (!serverName) {
    return NextResponse.json(
      { error: "server não autenticado." },
      { status: 401 },
    );
  }
  const { signal } = request;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let heartbeatId: ReturnType<typeof setInterval> | undefined;

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
        controller.enqueue(encoder.encode(": heartbeat\n\n"));
      }

      function closeStream(unsubscribe: () => void) {
        if (closed) return;
        closed = true;
        if (heartbeatId) clearInterval(heartbeatId);
        unsubscribe();
        controller.close();
      }

      // envia snapshot inicial
      sendRetryHint(3000);
      send({ type: "snapshot", ...(await getSnapshot(serverName)) });

      // assina mudanças
      const unsubscribe = subscribeToChanges(serverName, (payload) => {
        send({ type: "update", ...payload });
      });

      // heartbeat evita timeout silencioso em conexões longas
      heartbeatId = setInterval(() => {
        sendHeartbeat();
      }, 15000);

      // encerra quando o cliente desconectar
      signal.addEventListener("abort", () => {
        closeStream(unsubscribe);
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

