import { config } from "../config.js";
import { ocrBuffer } from "../ocr.js";
import type { RawItem } from "./types.js";

/**
 * Telegram OFFICIAL API adapter (MTProto via GramJS).
 *
 * When TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION are set, this
 * reads channel messages through Telegram's own API — the same API the
 * Telegram apps use, with credentials you get free from my.telegram.org. This
 * is far better than scraping the public web preview:
 *   - real-time-fresh messages (not just the preview page)
 *   - channels that have web-preview disabled
 *   - photo messages downloaded directly for OCR
 *
 * No credentials ⇒ telegramClientEnabled() is false and callers fall back to
 * the public-preview scraper, so the app runs unchanged without a key.
 */

export const telegramClientEnabled = () =>
  config.telegram.apiId > 0 && !!config.telegram.apiHash && !!config.telegram.session;

// GramJS is only imported when actually enabled, so the dependency is optional
// at runtime and the app boots fine even if it isn't installed.
let clientPromise: Promise<any> | null = null;

async function getClient(): Promise<any> {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const { TelegramClient } = await import("telegram");
    const { StringSession } = await import("telegram/sessions/index.js");
    const client = new TelegramClient(
      new StringSession(config.telegram.session),
      config.telegram.apiId,
      config.telegram.apiHash,
      { connectionRetries: 3, autoReconnect: true },
    );
    // Quiet GramJS's own logging.
    try {
      (client.setLogLevel as ((l: string) => void) | undefined)?.("error");
    } catch {
      /* older versions */
    }
    await client.connect();
    return client;
  })();
  return clientPromise;
}

/** Fetch recent messages from one channel via the official API. */
export async function fetchTelegramViaClient(channel: string): Promise<RawItem[]> {
  const client = await getClient();
  const messages = await client.getMessages(channel, { limit: config.telegram.messageLimit });
  const items: RawItem[] = [];
  let ocrBudget = config.telegram.ocrPerChannel;

  for (const m of messages) {
    if (!m) continue;
    const publishedAt = m.date ? new Date(Number(m.date) * 1000).toISOString() : undefined;
    const id = m.id;
    const link = id ? `https://t.me/${channel}/${id}` : `https://t.me/${channel}`;
    const text: string = (m.message ?? m.text ?? "").toString();

    if (text.trim()) {
      items.push({
        title: text.slice(0, 120),
        content: text,
        url: link,
        author: `@${channel}`,
        publishedAt,
      });
    }

    // Photo messages: download the image and OCR it here (no public URL exists
    // for MTProto media). Bounded per channel per cycle to keep cost steady.
    const hasPhoto = !!m.photo || (m.media && (m.media.photo || m.media.className === "MessageMediaPhoto"));
    if (hasPhoto && ocrBudget > 0) {
      ocrBudget -= 1;
      try {
        const buf: Buffer = await client.downloadMedia(m, {});
        if (buf && buf.length > 100) {
          const ocrText = await ocrBuffer(buf);
          if (ocrText.trim()) {
            items.push({
              title: "image",
              content: ocrText,
              url: link,
              author: `@${channel}`,
              publishedAt,
            });
          }
        }
      } catch {
        /* skip this image */
      }
    }
  }

  return items;
}

/** Best-effort disconnect (used on shutdown). */
export async function disconnectTelegramClient(): Promise<void> {
  if (!clientPromise) return;
  try {
    const client = await clientPromise;
    await client.disconnect?.();
  } catch {
    /* ignore */
  }
}
