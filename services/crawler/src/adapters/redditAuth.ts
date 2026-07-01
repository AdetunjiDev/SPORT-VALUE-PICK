import { config } from "../config.js";

/**
 * Reddit application-only OAuth (client_credentials grant).
 * Register a free app at https://www.reddit.com/prefs/apps (type: "script"
 * or "web app"), then set REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET in .env.
 * Without them we fall back to the public .json endpoint (often 403 from
 * cloud/datacenter IPs — that's a Reddit restriction, handled gracefully).
 */

let cachedToken: { value: string; expiresAt: number } | null = null;

export function hasRedditCreds(): boolean {
  return Boolean(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET);
}

export async function getRedditToken(): Promise<string | null> {
  if (!hasRedditCreds()) return null;
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.value;
  }

  const id = process.env.REDDIT_CLIENT_ID!;
  const secret = process.env.REDDIT_CLIENT_SECRET!;
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");

  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": config.userAgent,
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    throw new Error(`Reddit auth failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("Reddit auth: no access_token");

  cachedToken = {
    value: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
  return cachedToken.value;
}
