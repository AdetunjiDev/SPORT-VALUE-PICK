import { prisma } from "@sportybet/db";

/**
 * Quick health check: try to query the sources table to see if migrations
 * have been run. Returns true if schema is initialized, false otherwise.
 * This doesn't run migrations here—that must be done via migrate-db endpoint.
 */
export async function runMigrations(): Promise<boolean> {
  console.log("[runMigrations] Checking if database schema is initialized…");

  try {
    // Simple test: try to count sources
    // If this works, the schema exists
    const count = await prisma.source.count();
    console.log(
      `[runMigrations] ✓ Database schema is initialized (${count} sources found).`,
    );
    return true;
  } catch (err: any) {
    // Check if it's the "table doesn't exist" error
    if (err?.code === "P2021") {
      console.warn(
        "[runMigrations] ✗ Database schema not initialized.",
        "Tables do not exist. To initialize:",
        "1. Visit https://migrate-db-production.up.railway.app",
        "2. It will run 'prisma migrate deploy' and create the schema",
        "3. Then the crawler will work on next startup",
      );
      return false;
    }

    // Other errors
    console.error(
      "[runMigrations] Database check failed:",
      err?.message ?? err,
    );
    return false;
  }
}

