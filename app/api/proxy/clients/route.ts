import { NextRequest, NextResponse } from "next/server";
import { getMergedClient, getMergedClientsByServer } from "@/lib/server/proxy-clients";
import { setClientConfigOverride } from "@/lib/server/client-config";
import { verifyClientEditPassword } from "@/lib/server/client-auth";
import { getServerSession } from "@/lib/server/server-session";
import type { ProxyServiceInfo } from "@/types/proxy-client";

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
      const client = await getMergedClient(session.serverName, clientId);
      
      if (!client) {
        return NextResponse.json(
          { error: "Client not found" },
          { status: 404 }
        );
      }
      
      return NextResponse.json({ client });
    }

    const clients = await getMergedClientsByServer(session.serverName);

    return NextResponse.json({ clients });
  } catch (err) {
    console.error("Error listing proxy clients:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await getServerSession();

    if (!session.authenticated || !session.serverName) {
      return NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 },
      );
    }

    const body = await request.json();
    const { clientId, clientName, localServices, password } = body as {
      clientId?: string;
      clientName?: string;
      localServices?: ProxyServiceInfo[];
      password?: string;
    };

    if (!clientId?.trim()) {
      return NextResponse.json(
        { error: "clientId é obrigatório" },
        { status: 400 },
      );
    }

    const verification = await verifyClientEditPassword(
      session.serverName,
      clientId,
      password,
    );
    if (!verification.ok) {
      return NextResponse.json(
        { error: verification.message ?? "Senha do cliente inválida." },
        { status: 403 },
      );
    }

    if (!clientName?.trim()) {
      return NextResponse.json(
        { error: "clientName é obrigatório" },
        { status: 400 },
      );
    }

    if (!Array.isArray(localServices)) {
      return NextResponse.json(
        { error: "localServices precisa ser um array" },
        { status: 400 },
      );
    }

    for (const service of localServices) {
      if (!service.name?.trim() || !service.port) {
        return NextResponse.json(
          { error: "Cada serviço precisa de name e port" },
          { status: 400 },
        );
      }
    }

    const existing = await getMergedClient(session.serverName, clientId);
    if (!existing) {
      return NextResponse.json(
        { error: "Client not found" },
        { status: 404 },
      );
    }

    const override = await setClientConfigOverride(
      session.serverName,
      clientId,
      {
        clientName: clientName.trim(),
        localServices: localServices.map((service) => ({
          name: service.name.trim(),
          host: service.host?.trim() || "localhost",
          port: Number(service.port),
        })),
      },
    );

    const client = await getMergedClient(session.serverName, clientId);

    return NextResponse.json({ ok: true, override, client });
  } catch (err) {
    console.error("Error updating proxy client:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
