import { startServer } from "./server.js";
import { startScheduler, stopScheduler } from "./scheduler.js";
import { prisma } from "@sportybet/db";
import { runMigrations } from "./runMigrations.js";

console.log("SportyBet AI · Crawler v1 starting…");

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException] FATAL:", err?.message ?? err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection] Non-fatal rejection caught, continuing:", reason);
});

let server: ReturnType<typeof startServer> | undefined;

function bootstrap() {
  // Ensure the database schema is up to date before anything tries to use
  // it (e.g. the scheduler querying the `sources` table). This runs once
  // on startup, applying any pending migrations.
  runMigrations().then(migrated => {
    if (!migrated) {
      console.warn(
        "[bootstrap] Database migrations status unknown — starting server in read-only mode. Crawler scheduler disabled until DB is initialized.",
      );
    }
    
    server = startServer();
    
    // Only start the scheduler if we're confident the database schema exists
    if (migrated) {
      // Give server time to bind before starting scheduler
      setTimeout(() => {
        startScheduler();
      }, 500);
    } else {
      console.warn("[bootstrap] Scheduler not started — database schema may not be initialized.");
    }
  }).catch((err) => {
    console.error("[bootstrap] Fatal error during startup:", err?.message ?? err);
    process.exit(1);
  });
}

bootstrap();

async function shutdown() {
  console.log("\nShutting down…");
  stopScheduler();
  server?.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

