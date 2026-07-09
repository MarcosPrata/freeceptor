import { createServer } from "http";
import { parse } from "url";
import next from "next";
import { createWebSocketServer, closeWebSocketServer } from "../lib/server/websocket/index.js";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME || "localhost";
const port = parseInt(process.env.PORT || "3001", 10);
const wsPath = process.env.WS_PATH || "/ws";

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

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
    console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║                    Freeceptor Server                               ║
╠═══════════════════════════════════════════════════════════════════╣
║  HTTP Server:     http://${hostname}:${port}                            ║
║  WebSocket:       ws://${hostname}:${port}${wsPath}                           ║
║  Mode:            ${dev ? "development" : "production"}                                    ║
╚═══════════════════════════════════════════════════════════════════╝
`);
  });

  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await closeWebSocketServer();
    server.close(() => {
      console.log("Goodbye!");
      process.exit(0);
    });
  });

  process.on("SIGTERM", async () => {
    await closeWebSocketServer();
    server.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
