import { NextResponse } from "next/server";
import { getServerFromCookie } from "@/lib/server/server-session";
import { getLiveStream } from "@/lib/server/live-streams";
import {
  clampFakeIntervalMs,
  emitFakeSseEvent,
  hasMockSsePusher,
  setMockFakeEvents,
} from "@/lib/server/mock-sse";

export const dynamic = "force-dynamic";

function unauthorized() {
  return NextResponse.json(
    { error: "server não autenticado." },
    { status: 401 },
  );
}

export async function POST(request: Request) {
  const serverName = getServerFromCookie(request);
  if (!serverName) return unauthorized();

  const body = (await request.json().catch(() => null)) as {
    requestId?: string;
    enabled?: boolean;
    intervalMs?: number;
    emitOnce?: boolean;
  } | null;

  const requestId = body?.requestId?.trim();
  if (!requestId) {
    return NextResponse.json({ error: "requestId é obrigatório." }, { status: 400 });
  }

  const stream = getLiveStream(requestId);
  if (!stream || stream.serverName !== serverName) {
    return NextResponse.json({ error: "stream não encontrado." }, { status: 404 });
  }
  if (stream.closedAt) {
    return NextResponse.json({ error: "stream já fechou." }, { status: 409 });
  }
  if (!stream.mock || !hasMockSsePusher(requestId)) {
    return NextResponse.json(
      { error: "eventos fake só existem em streams mock (sem proxy)." },
      { status: 400 },
    );
  }

  if (body?.emitOnce) {
    const ok = await emitFakeSseEvent(requestId);
    return NextResponse.json({ ok, emitOnce: true });
  }

  const enabling = body?.enabled === true && !stream.fakeEventsEnabled;
  const next = setMockFakeEvents(requestId, {
    enabled: Boolean(body?.enabled),
    intervalMs:
      typeof body?.intervalMs === "number"
        ? clampFakeIntervalMs(body.intervalMs)
        : undefined,
    emitNow: enabling,
  });

  return NextResponse.json({ ok: true, ...next });
}
