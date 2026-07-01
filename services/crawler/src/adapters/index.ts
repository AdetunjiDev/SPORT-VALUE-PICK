import { fetchRss } from "./rss.js";
import { fetchReddit } from "./reddit.js";
import { fetchTelegram } from "./telegram.js";
import type { RawItem, SourceLike } from "./types.js";

/** Dispatch a source to its adapter. Unknown/risky types are skipped. */
export async function fetchSource(source: SourceLike): Promise<RawItem[]> {
  switch (source.type) {
    case "GOOGLE_NEWS":
    case "BING_NEWS":
    case "RSS":
    case "YOUTUBE": // YouTube search RSS is XML too
      return fetchRss(source);
    case "REDDIT":
      return fetchReddit(source);
    case "TELEGRAM":
      // Public t.me/s/<channel> preview — no auth, sanctioned public page.
      return fetchTelegram(source);
    default:
      // WEBSITE/API scrapers intentionally not implemented in v1
      // (compliance-safe posture — see README).
      return [];
  }
}

export type { RawItem, SourceLike };
