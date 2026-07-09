import { getDb } from "@/lib/server/mongo";
import type {
  ProxyClientInfo,
  ProxyServiceInfo,
  ProxyRequestMessage,
  ProxyResponseMessage,
} from "@/types/proxy-client";

type ProxyClientDoc = {
  _id: string;
  clientId: string;
  clientName: string;
  serverName: string;
  localServices: ProxyServiceInfo[];
  connectedAt: string;
  lastHeartbeat: string;
  status: "online" | "offline";
};

type PendingRequestDoc = {
  _id: string;
  requestId: string;
  targetClientId: string;
  serverName: string;
  serviceName: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  createdAt: string;
  status: "pending" | "processing" | "completed" | "failed";
};

type RequestResponseDoc = {
  _id: string;
  requestId: string;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  error?: string;
  completedAt: string;
};

const HEARTBEAT_TIMEOUT_MS = 60000;

async function proxyClientsCollection() {
  const db = await getDb();
  return db.collection<ProxyClientDoc>("proxy_clients");
}

async function pendingRequestsCollection() {
  const db = await getDb();
  return db.collection<PendingRequestDoc>("proxy_pending_requests");
}

async function requestResponsesCollection() {
  const db = await getDb();
  return db.collection<RequestResponseDoc>("proxy_request_responses");
}

function buildClientDocId(serverName: string, clientId: string): string {
  return `${serverName}:${clientId}`;
}

export async function registerProxyClient(
  serverName: string,
  clientId: string,
  clientName: string,
  localServices: ProxyServiceInfo[]
): Promise<ProxyClientInfo> {
  const collection = await proxyClientsCollection();
  const now = new Date().toISOString();
  const docId = buildClientDocId(serverName, clientId);

  const doc: ProxyClientDoc = {
    _id: docId,
    clientId,
    clientName,
    serverName,
    localServices,
    connectedAt: now,
    lastHeartbeat: now,
    status: "online",
  };

  await collection.updateOne(
    { _id: docId },
    {
      $set: {
        clientName,
        localServices,
        lastHeartbeat: now,
        status: "online",
      },
      $setOnInsert: {
        _id: docId,
        clientId,
        serverName,
        connectedAt: now,
      },
    },
    { upsert: true }
  );

  return {
    clientId: doc.clientId,
    clientName: doc.clientName,
    serverName: doc.serverName,
    localServices: doc.localServices,
    connectedAt: doc.connectedAt,
    lastHeartbeat: doc.lastHeartbeat,
    status: doc.status,
  };
}

export async function updateHeartbeat(
  serverName: string,
  clientId: string
): Promise<boolean> {
  const collection = await proxyClientsCollection();
  const docId = buildClientDocId(serverName, clientId);
  const now = new Date().toISOString();

  const result = await collection.updateOne(
    { _id: docId },
    { $set: { lastHeartbeat: now, status: "online" } }
  );

  return result.matchedCount > 0;
}

export async function unregisterProxyClient(
  serverName: string,
  clientId: string
): Promise<boolean> {
  const collection = await proxyClientsCollection();
  const docId = buildClientDocId(serverName, clientId);

  const result = await collection.updateOne(
    { _id: docId },
    { $set: { status: "offline" } }
  );

  return result.matchedCount > 0;
}

export async function listProxyClients(
  serverName: string
): Promise<ProxyClientInfo[]> {
  const collection = await proxyClientsCollection();
  const cutoff = new Date(Date.now() - HEARTBEAT_TIMEOUT_MS).toISOString();

  await collection.updateMany(
    {
      serverName,
      status: "online",
      lastHeartbeat: { $lt: cutoff },
    },
    { $set: { status: "offline" } }
  );

  const docs = await collection
    .find({ serverName })
    .sort({ status: 1, lastHeartbeat: -1 })
    .toArray();

  return docs.map((doc) => ({
    clientId: doc.clientId,
    clientName: doc.clientName,
    serverName: doc.serverName,
    localServices: doc.localServices,
    connectedAt: doc.connectedAt,
    lastHeartbeat: doc.lastHeartbeat,
    status: doc.status,
  }));
}

export async function getProxyClient(
  serverName: string,
  clientId: string
): Promise<ProxyClientInfo | null> {
  const collection = await proxyClientsCollection();
  const docId = buildClientDocId(serverName, clientId);

  const doc = await collection.findOne({ _id: docId });
  if (!doc) return null;

  const cutoff = new Date(Date.now() - HEARTBEAT_TIMEOUT_MS).toISOString();
  if (doc.status === "online" && doc.lastHeartbeat < cutoff) {
    await collection.updateOne({ _id: docId }, { $set: { status: "offline" } });
    doc.status = "offline";
  }

  return {
    clientId: doc.clientId,
    clientName: doc.clientName,
    serverName: doc.serverName,
    localServices: doc.localServices,
    connectedAt: doc.connectedAt,
    lastHeartbeat: doc.lastHeartbeat,
    status: doc.status,
  };
}

export async function sendRequestToClient(
  serverName: string,
  targetClientId: string,
  serviceName: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: unknown
): Promise<string> {
  const requestId = `req-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

  const collection = await pendingRequestsCollection();
  const doc: PendingRequestDoc = {
    _id: requestId,
    requestId,
    targetClientId,
    serverName,
    serviceName,
    method,
    path,
    headers,
    body,
    createdAt: new Date().toISOString(),
    status: "pending",
  };

  await collection.insertOne(doc);

  return requestId;
}

export async function getPendingRequests(
  serverName: string,
  clientId: string
): Promise<ProxyRequestMessage[]> {
  const collection = await pendingRequestsCollection();

  const docs = await collection
    .find({
      serverName,
      targetClientId: clientId,
      status: "pending",
    })
    .sort({ createdAt: 1 })
    .limit(10)
    .toArray();

  if (docs.length > 0) {
    const ids = docs.map((d) => d._id);
    await collection.updateMany(
      { _id: { $in: ids } },
      { $set: { status: "processing" } }
    );
  }

  return docs.map((doc) => ({
    type: "request",
    requestId: doc.requestId,
    targetClientId: doc.targetClientId,
    serviceName: doc.serviceName,
    method: doc.method,
    path: doc.path,
    headers: doc.headers,
    body: doc.body,
  }));
}

export async function saveRequestResponse(
  requestId: string,
  response: Omit<ProxyResponseMessage, "type" | "requestId">
): Promise<void> {
  const pendingCollection = await pendingRequestsCollection();
  const responseCollection = await requestResponsesCollection();

  await pendingCollection.updateOne(
    { _id: requestId },
    { $set: { status: response.error ? "failed" : "completed" } }
  );

  const doc: RequestResponseDoc = {
    _id: requestId,
    requestId,
    status: response.status,
    headers: response.headers,
    body: response.body,
    error: response.error,
    completedAt: new Date().toISOString(),
  };

  await responseCollection.updateOne(
    { _id: requestId },
    { $set: doc },
    { upsert: true }
  );
}

export async function getRequestResponse(
  requestId: string,
  timeoutMs: number = 30000
): Promise<ProxyResponseMessage | null> {
  const responseCollection = await requestResponsesCollection();
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const doc = await responseCollection.findOne({ _id: requestId });
    if (doc) {
      return {
        type: "response",
        requestId: doc.requestId,
        status: doc.status,
        headers: doc.headers,
        body: doc.body,
        error: doc.error,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return null;
}

export async function cleanupOldRequests(): Promise<void> {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const pendingCollection = await pendingRequestsCollection();
  const responseCollection = await requestResponsesCollection();

  await pendingCollection.deleteMany({ createdAt: { $lt: cutoff } });
  await responseCollection.deleteMany({ completedAt: { $lt: cutoff } });
}
