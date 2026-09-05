// =====================================================================
// Netlify runtime bootstrap helpers.
//
// Call preparePrismaEnv() at the start of every function invocation,
// before any Prisma query. The engine binary is staged next to the
// function during the Netlify build.
// =====================================================================
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RHEL_ENGINE = "libquery_engine-rhel-openssl-3.0.x.so.node";

/** Point Prisma at the staged rhel engine before any query runs. */
export function preparePrismaEnv(): void {
  const existing = process.env.PRISMA_QUERY_ENGINE_LIBRARY;
  if (existing && existsSync(existing)) return;

  // When bundled into netlify/functions/app.mjs, import.meta.url is that file.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, RHEL_ENGINE),
    join(here, "node_modules", ".prisma", "client", RHEL_ENGINE),
    join(process.cwd(), "netlify", "functions", RHEL_ENGINE),
    join(process.cwd(), "netlify", "functions", "node_modules", ".prisma", "client", RHEL_ENGINE),
    join(process.cwd(), "packages", "db", "generated", "client", RHEL_ENGINE),
  ];

  for (const p of candidates) {
    if (existsSync(p)) {
      process.env.PRISMA_QUERY_ENGINE_LIBRARY = p;
      return;
    }
  }
}

export function missingDatabaseUrlMessage(): string | null {
  if (!process.env.DATABASE_URL?.trim()) {
    return [
      "DATABASE_URL is not set in the Netlify environment.",
      "Site settings -> Environment variables -> add DATABASE_URL (and DIRECT_URL),",
      "then Clear cache and deploy.",
    ].join(" ");
  }
  return null;
}

export function errorHtml(title: string, detail: string): Response {
  const safe = detail.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<style>
  body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1.25rem;line-height:1.5;color:#111;background:#fafafa}
  h1{font-size:1.25rem;margin:0 0 .75rem}
  pre{white-space:pre-wrap;word-break:break-word;background:#111;color:#e8e8e8;padding:1rem;border-radius:8px;font-size:12px;overflow:auto}
  p{color:#444;font-size:.95rem}
</style></head><body>
<h1>${title}</h1>
<pre>${safe}</pre>
<p>Open Netlify -> Functions -> <strong>app</strong> logs for the full stack. After fixing env/build, use <em>Clear cache and deploy</em>.</p>
</body></html>`;
  return new Response(html, {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Friendly page when we hit our soft deadline before Netlify's hard ~10s kill. */
export function softTimeoutHtml(retryPath = "/"): Response {
  const safePath = retryPath.startsWith("/") ? retryPath : "/";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta http-equiv="refresh" content="3;url=${safePath}">
<title>Still warming up</title>
<style>
  body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1.25rem;line-height:1.5;color:#111;background:#fafafa;text-align:center}
  h1{font-size:1.35rem;margin:0 0 .75rem}
  p{color:#444}
  a{display:inline-block;margin-top:1.25rem;padding:.65rem 1.1rem;border-radius:8px;background:#111;color:#fff;text-decoration:none;font-weight:600}
</style></head><body>
<h1>Still warming up</h1>
<p>This page is taking a moment on Netlify's free tier. Retrying automatically in a few seconds&hellip;</p>
<p>If a crawl just finished, the next try is usually instant.</p>
<a href="${safePath}">Retry now</a>
</body></html>`;
  return new Response(html, {
    status: 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "retry-after": "3",
    },
  });
}

export class SoftTimeoutError extends Error {
  constructor(ms: number) {
    super(`Request exceeded soft deadline of ${ms}ms (Netlify sync limit is ~10s)`);
    this.name = "SoftTimeoutError";
  }
}

export function formatErr(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}\n\n${err.stack ?? ""}`;
  return String(err);
}
