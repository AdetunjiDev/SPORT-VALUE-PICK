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

/**
 * Race a promise against a timeout. GramJS's MTProto socket can go dead after
 * the host sleeps and then hang getMessages()/connect() forever (it doesn't
 * honour our fetch timeout). Without this guard a single dead call freezes the
 * whole 3-minute scan cycle. On timeout we reject so the caller falls back to
 * the web-preview scrape, and we drop the stale client so the next cycle
 * reconnects fresh.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Drop the cached client so the next call reconnects from scratch. */
async function resetClient(): Promise<void> {
  const cur = clientPromise;
  clientPromise = null;
  if (!cur) return;
  try {
    const c = await cur;
    await c?.disconnect?.();
  } catch {
    /* ignore */
  }
}

async function getClient(): Promise<any> {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const { TelegramClient } = await import("telegram");
    const { StringSession } = await import("telegram/sessions/index.js");
    const client = new TelegramClient(
      new StringSession(config.telegram.session),
      config.telegram.apiId,
      config.telegram.apiHash,
      { connectionRetries: 1, autoReconnect: false },
    );
    // Quiet GramJS's own logging.
    try {
      (client.setLogLevel as ((l: string) => void) | undefined)?.("error");
    } catch {
      /* older versions */
    }
    try {
      await withTimeout(client.connect(), 15_000, "telegram connect");
    } catch (err) {
      // Reset so the next call can retry rather than hanging on this rejected promise.
      clientPromise = null;
      throw new Error(`Telegram connect failed (check TELEGRAM_API_ID/HASH/SESSION): ${err}`);
    }
    return client;
  })();
  // If the promise itself rejects, clear it so callers can retry.
  clientPromise.catch(() => { clientPromise = null; });
  return clientPromise;
}

/** Fetch recent messages from one channel via the official API. */
export async function fetchTelegramViaClient(channel: string): Promise<RawItem[]> {
  const client = await getClient();
  let messages: any[];
  try {
    messages = await withTimeout(
      client.getMessages(channel, { limit: config.telegram.messageLimit }),
      15_000,
      `telegram getMessages(@${channel})`,
    );
  } catch (e) {
    // A hung/failed read means the socket is likely dead — drop the client so
    // the next cycle reconnects, and let the caller fall back to web-preview.
    void resetClient();
    throw e;
  }
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
        const buf: Buffer = await withTimeout(
          client.downloadMedia(m, {}),
          15_000,
          "telegram downloadMedia",
        );
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
