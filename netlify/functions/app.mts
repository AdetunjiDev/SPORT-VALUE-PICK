// =====================================================================
// Netlify Function: the whole web app.
//
// server.ts is written against node:http. Netlify Functions v2 speak the
// Web Fetch API. This adapts one to the other so a single copy of the
// routing/rendering code serves both the local listener and Netlify.
//
// Two details that are easy to get wrong and fail only in production:
//   1. readBody() in server.ts uses req.on("data"/"end"), so the request
//      object must be a real Readable stream, not a plain object.
//   2. The sign-in routes emit Set-Cookie as an ARRAY of strings. Headers
//      .set() would collapse those into one malformed header and silently
//      break login, so array values must be .append()-ed individually.
// =====================================================================
import type { Context } from "@netlify/functions";
import { Readable } from "node:stream";
import type http from "node:http";
import { handleRequest } from "../../services/crawler/src/server.js";

export default async (request: Request, context: Context): Promise<Response> => {
  const url = new URL(request.url);

  // ---- Request -> http.IncomingMessage ----
  const raw =
    request.method === "GET" || request.method === "HEAD"
      ? Buffer.alloc(0)
      : Buffer.from(await request.arrayBuffer());

  const req = Readable.from(raw.length ? [raw] : []) as unknown as http.IncomingMessage;
  req.url = url.pathname + url.search;
  req.method = request.method;
  req.headers = Object.fromEntries(request.headers.entries()) as http.IncomingHttpHeaders;
  // server.ts reads req.socket.remoteAddress for rate limiting.
  (req as unknown as { socket: { remoteAddress: string } }).socket = {
    remoteAddress:
      request.headers.get("x-nf-client-connection-ip") ??
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      "0.0.0.0",
  };

  // ---- http.ServerResponse -> Response ----
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
      // Set-Cookie and friends: one header line per entry.
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
  // handleRequest awaits its own work, but end() can be called from a
  // callback a tick later; this makes the ordering explicit.
  if (!finished) await done;

  const body = status === 204 || status === 304 ? null : Buffer.concat(chunks);
  return new Response(body, { status, headers });
};

// Every path goes to this function -- the app renders all of its own routes.
export const config = { path: "/*" };
