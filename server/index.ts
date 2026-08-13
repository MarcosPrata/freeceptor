import { createServer } from "http";
import { parse } from "url";
import next from "next";
import { createWebSocketServer, closeWebSocketServer } from "../lib/server/websocket/index";
import { version } from "../package.json";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME || "localhost";
const port = parseInt(process.env.PORT || "8001", 10);
const wsPath = process.env.WS_PATH || "/ws";

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

function padLine(content: string, width = 67): string {
  const truncated = content.length > width ? content.slice(0, width) : content;
  return truncated.padEnd(width, " ");
}

async function main() {
  await app.prepare();

  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url || "", true);
    handle(req, res, parsedUrl);
  });

  createWebSocketServer({
    server,
    path: wsPath,
  });

  server.listen(port, () => {
    const mode = dev ? "development" : "production";
    console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║${padLine(`  Freeceptor Server v${version}`)}║
╠═══════════════════════════════════════════════════════════════════╣
║${padLine(`  HTTP Server:     http://${hostname}:${port}`)}║
║${padLine(`  WebSocket:       ws://${hostname}:${port}${wsPath}`)}║
║${padLine(`  Mode:            ${mode}`)}║
╚═══════════════════════════════════════════════════════════════════╝
`);
  });

  // Ctrl+C used to orphan this process: yarn dies, Node stays in
  // `server.close()` waiting for the dashboard SSE (`GET /api/events`)
  // and any mock stream. The listen socket is already gone, so `lsof :8001`
  // looks free while `.next/dev/lock` is still held.
  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) {
      process.exit(1);
    }
    shuttingDown = true;
    console.log("\nShutting down...");

    const force = setTimeout(() => process.exit(1), 2000);
    force.unref();

    void closeWebSocketServer().finally(() => {
      server.close(() => {
        clearTimeout(force);
        console.log("Goodbye!");
        process.exit(0);
      });
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
    });
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
