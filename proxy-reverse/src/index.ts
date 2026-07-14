import { config as loadEnv } from "dotenv";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { loadAgentConfig } from "./config.js";
import { FreeceptorHTTPServer } from "./http-server.js";

const dir = dirname(fileURLToPath(import.meta.url));
const envPath = join(dir, "../.env");
const configPath = join(dir, "../agent-config.json");

// Load .env for backward-compat migration (used by loadAgentConfig fallback)
loadEnv({ path: envPath, override: true });

function main() {
  console.log("╔═══════════════════════════════════════════════════════╗");
  console.log("║       Freeceptor Reverse Proxy Agent v2.0             ║");
  console.log("║                  (WebSocket Mode)                     ║");
  console.log("╚═══════════════════════════════════════════════════════╝");
  console.log();

  const uiPort = parseInt(process.env.UI_PORT ?? "8081", 10);
  const agentConfig = loadAgentConfig(configPath);

  console.log("Configuration:");
  console.log(`  Client ID:      ${agentConfig.clientId}`);
  console.log(`  Client Name:    ${agentConfig.clientName}`);
  console.log(`  Freeceptor URL: ${agentConfig.freeceptorUrl || "(not set)"}`);
  console.log(`  Connections:    ${agentConfig.connections.length}`);
  console.log();

  for (const conn of agentConfig.connections) {
    const svcs = conn.localServices.map((s) => `${s.name}:${s.port}`).join(", ");
    console.log(`  → ${conn.serverName}${svcs ? `  [${svcs}]` : ""}`);
  }
  if (agentConfig.connections.length > 0) console.log();

  const httpServer = new FreeceptorHTTPServer(uiPort, configPath, agentConfig);
  httpServer.start();

  console.log("Press Ctrl+C to stop.");
  console.log();

  const shutdown = () => {
    console.log("\nShutting down...");
    httpServer.disconnectAll();
    httpServer.stop();
    setTimeout(() => {
      console.log("Goodbye!");
      process.exit(0);
    }, 1000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
