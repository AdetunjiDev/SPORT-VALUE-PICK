import { startServer } from "./server.js";
import { startScheduler, stopScheduler } from "./scheduler.js";
import { prisma } from "@sportybet/db";

console.log("SportyBet AI · Crawler v1 starting…");

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
