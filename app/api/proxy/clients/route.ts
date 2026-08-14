import { NextRequest, NextResponse } from "next/server";
import { getMergedClient, getMergedClientsByServer } from "@/lib/server/proxy-clients";
import { setClientConfigOverride } from "@/lib/server/client-config";
import { clientRequiresEditPassword } from "@/lib/server/client-auth";
import { getServerSession } from "@/lib/server/server-session";
import { clientManager } from "@/lib/server/websocket";
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
    const { clientId, clientName, localServices } = body as {
      clientId?: string;
      clientName?: string;
      localServices?: ProxyServiceInfo[];
    };

    if (!clientId?.trim()) {
      return NextResponse.json(
        { error: "clientId é obrigatório" },
        { status: 400 },
      );
    }

    // Cliente com senha só pode ser configurado no próprio Freeceptor Client.
    if (await clientRequiresEditPassword(session.serverName, clientId)) {
      return NextResponse.json(
        {
          error:
            "Este cliente tem senha. Altere a configuração no Freeceptor Client.",
        },
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

    const normalizedServices = localServices.map((service) => ({
      name: service.name.trim(),
      host: service.host?.trim() || "localhost",
      port: Number(service.port),
    }));
    const normalizedName = clientName.trim();

    const override = await setClientConfigOverride(
      session.serverName,
      clientId,
      {
        clientName: normalizedName,
        localServices: normalizedServices,
      },
    );

    // Atualiza o client em memória e empurra a config pelo WebSocket.
    clientManager.updateClientConfig(session.serverName, clientId, {
      clientName: normalizedName,
      localServices: normalizedServices,
    });
    const pushed = clientManager.sendToClient(session.serverName, clientId, {
      type: "config_update",
      clientName: normalizedName,
      localServices: normalizedServices,
    });

    const client = await getMergedClient(session.serverName, clientId);

    return NextResponse.json({ ok: true, override, client, pushed });
  } catch (err) {
    console.error("Error updating proxy client:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
