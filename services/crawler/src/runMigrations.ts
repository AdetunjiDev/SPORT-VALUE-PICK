import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// services/crawler/src -> repo root
const repoRoot = path.resolve(__dirname, "../../..");
const schemaPath = path.resolve(repoRoot, "packages/db/prisma/schema.prisma");

/**
 * Runs `prisma migrate deploy` against the configured DATABASE_URL so that
 * the database schema is always up to date before the app starts using it.
 *
 * Returns `true` if migrations ran successfully (or there was nothing to
 * do), and `false` if the migration command failed.
 */
export async function runMigrations(): Promise<boolean> {
  console.log("[runMigrations] Applying database migrations…");

  try {
    const output = execSync(
      `pnpm exec prisma migrate deploy --schema ${schemaPath}`,
      {
        cwd: repoRoot,
        env: process.env,
        stdio: "pipe",
        encoding: "utf-8",
      },
    );

    console.log(output.trim());
    console.log("[runMigrations] Migrations applied successfully.");
    return true;
  } catch (err: any) {
    const message = err?.stdout?.toString?.() ?? err?.message ?? err;
    console.error("[runMigrations] Failed to apply migrations:", message);
    return false;
  }
}
