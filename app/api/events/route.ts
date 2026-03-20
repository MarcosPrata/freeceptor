import { NextResponse } from "next/server";
import {
  getSnapshot,
  subscribeToChanges,
} from "@/lib/server/request-log";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { signal } = request;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function send(data: unknown) {
        const json = JSON.stringify(data);
        controller.enqueue(encoder.encode(`data: ${json}\n\n`));
      }

      // envia snapshot inicial
      send({ type: "snapshot", ...(await getSnapshot()) });

      // assina mudanças
      const unsubscribe = subscribeToChanges((payload) => {
        send({ type: "update", ...payload });
      });

      // encerra quando o cliente desconectar
      signal.addEventListener("abort", () => {
        unsubscribe();
        controller.close();
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

