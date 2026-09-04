// =====================================================================
// Netlify Function: the whole web app.
//
 // Sets PRISMA_QUERY_ENGINE_LIBRARY before any DB work, adapts Fetch API
 // <-> node:http for server.ts, and NEVER throws to Netlify (opaque
 // "An unknown error has occurred" only happens on unhandled throws).
 // =====================================================================
import type { Context } from "@netlify/functions";
import { Readable } from "node:stream";
import type http from "node:http";
import { handleRequest } from "../../services/crawler/src/server.js";
import {
  preparePrismaEnv,
  missingDatabaseUrlMessage,
  errorHtml,
  formatErr,
} from "./prisma-env.mts";

export default async (request: Request, _context: Context): Promise<Response> => {
  try {
    preparePrismaEnv();

    const dbMsg = missingDatabaseUrlMessage();
    if (dbMsg) return errorHtml("Missing DATABASE_URL", dbMsg);

    const url = new URL(request.url);

    const raw =
      request.method === "GET" || request.method === "HEAD"
        ? Buffer.alloc(0)
        : Buffer.from(await request.arrayBuffer());

    const req = Readable.from(raw.length ? [raw] : []) as unknown as http.IncomingMessage;
    req.url = url.pathname + url.search;
    req.method = request.method;
    req.headers = Object.fromEntries(request.headers.entries()) as http.IncomingHttpHeaders;
    (req as unknown as { socket: { remoteAddress: string } }).socket = {
      remoteAddress:
        request.headers.get("x-nf-client-connection-ip") ??
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
        "0.0.0.0",
    };

    let status = 200;
    const headers = new Headers();
    const chunks: Buffer[] = [];
    let finished = false;
    let markDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      markDone = resolve;
    });

    const put = (key: string, value: number | string | readonly string[]) => {
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, String(v));
      } else {
        headers.set(key, String(value));
      }
    };

    const res = {
      get headersSent() {
        return finished;
      },
      writeHead(code: number, maybeHeaders?: http.OutgoingHttpHeaders) {
        status = code;
        for (const [k, v] of Object.entries(maybeHeaders ?? {})) {
          if (v !== undefined) put(k, v as string | readonly string[]);
        }
        return res;
      },
      setHeader(k: string, v: number | string | readonly string[]) {
        put(k, v);
        return res;
      },
      getHeader(k: string) {
        return headers.get(k) ?? undefined;
      },
      removeHeader(k: string) {
        headers.delete(k);
      },
      write(chunk: string | Buffer) {
        chunks.push(Buffer.from(chunk as never));
        return true;
      },
      end(chunk?: string | Buffer) {
        if (chunk) chunks.push(Buffer.from(chunk as never));
        finished = true;
        markDone();
        return res;
      },
    } as unknown as http.ServerResponse;

    await handleRequest(req, res);
    if (!finished) await done;

    const body = status === 204 || status === 304 ? null : Buffer.concat(chunks);
    return new Response(body, { status, headers });
  } catch (err) {
    console.error("[netlify/app]", formatErr(err));
    return errorHtml("Function error", formatErr(err));
  }
};

export const config = { path: "/*" };
