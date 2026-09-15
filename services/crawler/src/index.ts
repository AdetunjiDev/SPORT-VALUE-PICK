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

/**
 * Arm the scheduler as soon as the database answers, retrying until it does.
 *
 * The previous version checked the schema exactly once and, on any failure,
 * left the crawler switched off for the life of the process. That is a real
 * outage mode, not a theoretical one: when Docker restarts both containers
 * together the crawler beats Postgres to the line, gets
 * "FATAL: the database system is starting up", and gives up — while the
 * dashboard keeps serving pages and looking perfectly healthy. It cost eight
 * days of lost crawling once already.
 *
 * Postgres is usually ready within seconds, so the backoff stays short at
 * first and then widens, and it never stops trying — a database that is down
 * now will come back, and the crawler should rejoin on its own.
 */
async function armSchedulerWhenReady(): Promise<void> {
  const backoffSec = [2, 3, 5, 8, 13, 21, 34, 60];
  for (let attempt = 0; ; attempt++) {
    if (await runMigrations()) {
      if (attempt > 0) {
        console.log(`[bootstrap] Database ready after ${attempt + 1} attempts — arming scheduler.`);
      }
      startScheduler();
      return;
    }
    const wait = backoffSec[Math.min(attempt, backoffSec.length - 1)];
    console.warn(
      `[bootstrap] Database not ready (attempt ${attempt + 1}) — retrying in ${wait}s. ` +
        "The dashboard is already serving; /health reports 503 until the crawler is armed.",
    );
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}

function bootstrap() {
  // Serve immediately. The dashboard only needs the database per request, so
  // it degrades on its own if the database is briefly away; there is no reason
  // to keep users waiting on a schema check.
  server = startServer();

  // Then keep trying to arm the crawl loop in the background, forever.
  void armSchedulerWhenReady();
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

