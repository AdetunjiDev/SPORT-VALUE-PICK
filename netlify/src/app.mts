// =====================================================================
// Netlify Function entry: bootstrap only.
//
 // Sets PRISMA_QUERY_ENGINE_LIBRARY, then dynamically loads the heavy
 // handler so PrismaClient is never constructed before the engine path
 // is known. Catches every failure and returns HTML. Netlify's generic
 // "An unknown error has occurred" page only appears when a function
 // throws or the process dies — we never throw from here.
 // =====================================================================
import type { Context } from "@netlify/functions";
import {
  preparePrismaEnv,
  missingDatabaseUrlMessage,
  errorHtml,
  formatErr,
} from "./prisma-env.mts";

export default async (request: Request, context: Context): Promise<Response> => {
  try {
    preparePrismaEnv();

    const dbMsg = missingDatabaseUrlMessage();
    if (dbMsg) return errorHtml("Missing DATABASE_URL", dbMsg);

    // Separate bundle so this runs BEFORE PrismaClient is constructed.
    const { default: handler } = await import("../runtime/app-handler.mjs");
    return await handler(request, context);
  } catch (err) {
    console.error("[netlify/app]", formatErr(err));
    return errorHtml("Function error", formatErr(err));
  }
};

export const config = { path: "/*" };
