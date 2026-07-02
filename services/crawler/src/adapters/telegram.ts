import { fetchText, stripHtml } from "./http.js";
import type { RawItem, SourceLike } from "./types.js";

/**
 * Telegram public channel preview (https://t.me/s/<channel>).
 * This is a PUBLIC, no-auth, sanctioned preview page — not scraping behind a
 * login. Channels like @SportybetOfficialChannel post real booking codes here.
 * config: { channel: "SportybetOfficialChannel" } (falls back to URL slug).
 */
export async function fetchTelegram(source: SourceLike): Promise<RawItem[]> {
  const channel =
    (source.config as { channel?: string })?.channel ??
    source.url.replace(/\/+$/, "").split("/").pop() ??
    "";
  const url = `https://t.me/s/${channel}`;
  const html = await fetchText(url, "text/html");

  // Each message bubble starts with class="tgme_widget_message ...".
  const chunks = html.split('class="tgme_widget_message ');
  const items: RawItem[] = [];

  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i];
    const post = chunk.match(/data-post="([^"]+)"/)?.[1]; // e.g. Channel/1234
    const datetime = chunk.match(/<time[^>]*datetime="([^"]+)"/)?.[1];
    const link = post ? `https://t.me/${post}` : url;
    const publishedAt = datetime ? new Date(datetime).toISOString() : undefined;

    const textMatch = chunk.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/);
    const text = textMatch ? stripHtml(textMatch[1]) : "";

    if (text) {
      items.push({
        title: text.slice(0, 120),
        content: text,
        url: link,
        author: `@${channel}`,
        publishedAt,
      });
    }

    // Image messages: many channels post codes as screenshots. Capture the
    // photo URL so the crawler can OCR it. (Handles text+image posts too.)
    const photo = chunk.match(/tgme_widget_message_photo_wrap[^>]*background-image:url\('([^']+)'\)/);
    if (photo) {
      items.push({
        title: "image",
        content: "",
        url: link,
        author: `@${channel}`,
        publishedAt,
        imageUrl: photo[1],
      });
    }
  }

  return items;
}
