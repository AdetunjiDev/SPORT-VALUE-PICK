/**
 * Placeholder: Migrations must be run separately before app deployment.
 * Visit the migrate-db endpoint to trigger Prisma migrations.
 * 
 * This function is kept for compatibility but migrations are run externally.
 */
export async function runMigrations(): Promise<boolean> {
  console.log(
    "[runMigrations] Skipping inline migrations. If database tables are missing, run migrations via the migrate-db endpoint.",
  );
  return true;
}

