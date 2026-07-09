import { loadConfig } from "./config.js";
import { FreeceptorWebSocketClient } from "./websocket-client.js";

function main() {
  console.log("╔═══════════════════════════════════════════════════════╗");
  console.log("║       Freeceptor Reverse Proxy Agent v2.0             ║");
  console.log("║                  (WebSocket Mode)                     ║");
  console.log("╚═══════════════════════════════════════════════════════╝");
  console.log();

  const config = loadConfig();

  console.log("Configuration:");
  console.log(`  Client ID:      ${config.clientId}`);
  console.log(`  Client Name:    ${config.clientName}`);
  console.log(`  Freeceptor URL: ${config.freeceptorUrl}`);
  console.log(`  Server Name:    ${config.serverName}`);
  console.log(`  Verbose:        ${config.verbose}`);
  console.log();

  if (config.localServices.length > 0) {
    console.log("Exposed Local Services:");
    for (const service of config.localServices) {
      console.log(`  - ${service.name}: ${service.host}:${service.port}`);
    }
    console.log();
  } else {
    console.log("No local services configured.");
    console.log("Set LOCAL_SERVICES to expose services (e.g., 'api:3000,db:5432')");
    console.log();
  }

  const client = new FreeceptorWebSocketClient(config);

  console.log("Connecting to Freeceptor via WebSocket...");
  console.log("Press Ctrl+C to stop.");
  console.log();

  client.connect();

  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    client.disconnect();
    setTimeout(() => {
      console.log("Goodbye!");
      process.exit(0);
    }, 1000);
  });

  process.on("SIGTERM", () => {
    client.disconnect();
    setTimeout(() => process.exit(0), 1000);
  });
}

main();
