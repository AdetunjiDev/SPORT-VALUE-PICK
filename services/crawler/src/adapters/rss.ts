import { XMLParser } from "fast-xml-parser";
import { fetchText, stripHtml } from "./http.js";
import type { RawItem, SourceLike } from "./types.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
});

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** Handles RSS 2.0 (Google News, blogs) and basic Atom feeds. */
export async function fetchRss(source: SourceLike): Promise<RawItem[]> {
  const xml = await fetchText(source.url, "application/rss+xml, application/xml, text/xml");
  const doc = parser.parse(xml);

  // RSS 2.0
  const rssItems = asArray(doc?.rss?.channel?.item);
  if (rssItems.length) {
    return rssItems.map((it: any) => {
      const title = stripHtml(String(it?.title ?? ""));
      const description = stripHtml(String(it?.description ?? it?.["content:encoded"] ?? ""));
      return {
        title,
        content: `${title}\n${description}`,
        url: typeof it?.link === "string" ? it.link : it?.link?.["#text"],
        author: it?.["dc:creator"] ?? it?.author,
        publishedAt: it?.pubDate ? new Date(it.pubDate).toISOString() : undefined,
      } satisfies RawItem;
    });
  }

  // Atom
  const atomEntries = asArray(doc?.feed?.entry);
  return atomEntries.map((e: any) => {
    const title = stripHtml(String(e?.title?.["#text"] ?? e?.title ?? ""));
    const summary = stripHtml(String(e?.summary?.["#text"] ?? e?.summary ?? e?.content ?? ""));
    const link = asArray(e?.link).find((l: any) => l?.["@_rel"] !== "self");
    return {
      title,
      content: `${title}\n${summary}`,
      url: link?.["@_href"] ?? e?.id,
      author: e?.author?.name,
      publishedAt: e?.updated ? new Date(e.updated).toISOString() : undefined,
    } satisfies RawItem;
  });
}
