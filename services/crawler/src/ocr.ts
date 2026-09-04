import { config } from "./config.js";

/**
 * OCR booking codes out of channel screenshots. Uses Tesseract (installed in
 * the container). Results are cached by image URL so repeated images in the
 * feed are only read once — keeping steady-state cost low.
 *
 * Tesseract is a SYSTEM BINARY, apt-installed in the Dockerfile. Serverless
 * runtimes (Netlify Functions) cannot install it, so the import is lazy and
 * failure is absorbed: where the binary is missing, every OCR call returns
 * "" and the crawler simply reads no codes out of images. Text sources —
 * Telegram messages, RSS, Reddit — are unaffected. Same posture as the
 * optional Redis in cache.ts: a missing dependency degrades a feature, it
 * never takes the process down.
 */

const cache = new Map<string, string>();

const OPTS = {
  lang: "eng",
  oem: 1,
  psm: 6, // assume a uniform block of text
};

type Tesseract = { recognize(input: Buffer, opts: typeof OPTS): Promise<string> };

let tesseractPromise: Promise<Tesseract | null> | undefined;
let warned = false;

/** Resolve the binding once; null means "no OCR available here". */
function getTesseract(): Promise<Tesseract | null> {
  tesseractPromise ??= import("node-tesseract-ocr")
    .then((m) => (m.default ?? m) as Tesseract)
    .catch(() => null);
  return tesseractPromise;
}

async function recognize(buf: Buffer): Promise<string> {
  const t = await getTesseract();
  if (!t) {
    if (!warned) {
      warned = true;
      console.warn("[ocr] tesseract unavailable — image OCR disabled, text sources unaffected.");
    }
    return "";
  }
  return (await t.recognize(buf, OPTS)).trim();
}

/** OCR an uploaded image buffer (bet-slip screenshots). */
export async function ocrBuffer(buf: Buffer): Promise<string> {
  try {
    return await recognize(buf);
  } catch {
    return "";
  }
}

export async function ocrImage(url: string): Promise<string> {
  const hit = cache.get(url);
  if (hit !== undefined) return hit;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fetchTimeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": config.userAgent },
      signal: controller.signal,
    });
    if (!res.ok) {
      cache.set(url, "");
      return "";
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const text = await recognize(buf);
    if (cache.size > 500) cache.clear(); // simple bound
    cache.set(url, text);
    return text;
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}
