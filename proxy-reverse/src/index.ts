import { loadConfig } from "./config.js";
import { createProxyServer } from "./proxy.js";

function main() {
  console.log("╔═══════════════════════════════════════════════════════╗");
  console.log("║         Freeceptor Reverse Proxy Agent                ║");
  console.log("╚═══════════════════════════════════════════════════════╝");
  console.log();

  const config = loadConfig();

  console.log("Configuration:");
  console.log(`  Local Port:     ${config.localPort}`);
  console.log(`  Freeceptor URL: ${config.freeceptorUrl}`);
  console.log(`  Server Name:    ${config.serverName}`);
  console.log(`  Target URL:     ${config.targetUrl}`);
  console.log(`  Verbose:        ${config.verbose}`);
  console.log();

  const server = createProxyServer(config);

  server.listen(config.localPort, () => {
    console.log(`Reverse proxy listening on http://localhost:${config.localPort}`);
    console.log();
    console.log("Requests will be:");
    console.log(`  1. Forwarded to: ${config.targetUrl}`);
    console.log(`  2. Logged to:    ${config.freeceptorUrl}/api/${config.serverName}/*`);
    console.log();
    console.log("Press Ctrl+C to stop.");
  });

  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    server.close(() => {
      console.log("Goodbye!");
      process.exit(0);
    });
  });

  process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
  });
}

main();
