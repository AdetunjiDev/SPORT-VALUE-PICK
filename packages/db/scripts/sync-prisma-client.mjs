// After `prisma generate` (custom output = ../generated/client), copy into
// node_modules/.prisma/client so `import "@prisma/client"` resolves the
// real client locally, in Docker, and on Netlify.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const generated = join(here, "..", "generated", "client");
const repoRoot = join(here, "..", "..", "..");
const dest = join(repoRoot, "node_modules", ".prisma", "client");

if (!existsSync(join(generated, "schema.prisma"))) {
  console.error(`sync-prisma-client: missing ${generated}/schema.prisma — run prisma generate first`);
  process.exit(1);
}

mkdirSync(dirname(dest), { recursive: true });
rmSync(dest, { recursive: true, force: true });
cpSync(generated, dest, { recursive: true });
console.log(`sync-prisma-client: ${generated} -> ${dest}`);
