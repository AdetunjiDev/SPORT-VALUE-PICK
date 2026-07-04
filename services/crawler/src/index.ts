import { startServer } from "./server.js";
import { startScheduler, stopScheduler } from "./scheduler.js";
import { prisma } from "@sportybet/db";

console.log("SportyBet AI · Crawler v1 starting…");

// Keep the process alive even if an external service (Telegram, OCR, etc.)
// throws an unhandled error — log it and continue.
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException] Non-fatal error caught, continuing:", err?.message ?? err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection] Non-fatal rejection caught, continuing:", reason);
});

const server = startServer();
startScheduler();

async function shutdown() {
  console.log("\nShutting down…");
  stopScheduler();
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

