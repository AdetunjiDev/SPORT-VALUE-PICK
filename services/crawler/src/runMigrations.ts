import { fileURLToPath } from "node:url";
import path from "node:path";
import { migrate } from "@prisma/migrate";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// services/crawler/src -> repo root
const repoRoot = path.resolve(__dirname, "../../..");
const schemaPath = path.resolve(repoRoot, "packages/db/prisma/schema.prisma");

/**
 * Runs database migrations programmatically against the configured DATABASE_URL
 * so that the database schema is always up to date before the app starts using it.
 *
 * Returns `true` if migrations ran successfully (or there was nothing to do),
 * and `false` if the migration command failed.
 */
export async function runMigrations(): Promise<boolean> {
  console.log("[runMigrations] Applying database migrations…");

  try {
    const result = await migrate({
      schemaPath,
      databaseUrl: process.env.DATABASE_URL,
    });

    console.log("[runMigrations] Migrations applied successfully.");
    if (result?.appliedMigrationNames?.length ?? 0 > 0) {
      console.log(
        `[runMigrations] Applied ${result?.appliedMigrationNames?.length ?? 0} migrations:`,
        result?.appliedMigrationNames?.join(", "),
      );
    } else {
      console.log("[runMigrations] Database already up to date.");
    }
    return true;
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.error("[runMigrations] Failed to apply migrations:", message);
    return false;
  }
}

