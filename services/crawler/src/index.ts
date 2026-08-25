import { startServer } from "./server.js";
import { startScheduler, stopScheduler } from "./scheduler.js";
import { prisma } from "@sportybet/db";
import { runMigrations } from "./runMigrations.js";

console.log("SportyBet AI · Crawler v1 starting…");

// Keep the process alive even if an external service (Telegram, OCR, etc.)
// throws an unhandled error — log it and continue.
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException] Non-fatal error caught, continuing:", err?.message ?? err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection] Non-fatal rejection caught, continuing:", reason);
});

let server: ReturnType<typeof startServer> | undefined;

async function bootstrap() {
  // Ensure the database schema is up to date before anything tries to use
  // it (e.g. the scheduler querying the `sources` table). This runs once
  // on startup, applying any pending migrations.
  const migrated = await runMigrations();
  if (!migrated) {
    console.error(
      "[bootstrap] Database migrations failed — continuing startup, but queries may fail until this is resolved.",
    );
  }

  server = startServer();
  startScheduler();
}

bootstrap().catch((err) => {
  console.error("[bootstrap] Fatal error during startup:", err?.message ?? err);
  process.exit(1);
});

async function shutdown() {
  console.log("\nShutting down…");
  stopScheduler();
  server?.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

