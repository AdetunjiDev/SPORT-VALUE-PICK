import { fetchJson } from "./http.js";
import { config } from "../config.js";
import { getRedditToken } from "./redditAuth.js";
import type { RawItem, SourceLike } from "./types.js";

interface RedditListing {
  data?: {
    children?: {
      data?: {
        title?: string;
        selftext?: string;
        url?: string;
        permalink?: string;
        author?: string;
        created_utc?: number;
      };
    }[];
  };
}

function mapChildren(json: RedditListing): RawItem[] {
  const children = json?.data?.children ?? [];
  return children.map((c) => {
    const d = c.data ?? {};
    const title = d.title ?? "";
    const body = d.selftext ?? "";
    return {
      title,
      content: `${title}\n${body}`,
      url: d.permalink ? `https://www.reddit.com${d.permalink}` : d.url,
      author: d.author,
      publishedAt: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : undefined,
    } satisfies RawItem;
  });
}

/**
 * Reddit search. Prefers OAuth (oauth.reddit.com) when credentials are set —
 * this is the compliant, reliable path and returns full post bodies where
 * booking codes actually appear. Falls back to the public .json endpoint.
 */
export async function fetchReddit(source: SourceLike): Promise<RawItem[]> {
  const token = await getRedditToken();

  if (token) {
    const query = (source.config as { query?: string })?.query ?? "sportybet booking code";
    const url = `https://oauth.reddit.com/search?q=${encodeURIComponent(query)}&sort=new&limit=25&type=link`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": config.userAgent },
    });
    if (!res.ok) throw new Error(`Reddit OAuth search: HTTP ${res.status}`);
    return mapChildren((await res.json()) as RedditListing);
  }

  // Fallback: public JSON (may be 403 from datacenter IPs).
  const json = await fetchJson<RedditListing>(source.url);
  return mapChildren(json);
}
