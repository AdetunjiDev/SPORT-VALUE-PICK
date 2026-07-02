import tesseract from "node-tesseract-ocr";
import { config } from "./config.js";

/**
 * OCR booking codes out of channel screenshots. Uses Tesseract (installed in
 * the container). Results are cached by image URL so repeated images in the
 * feed are only read once — keeping steady-state cost low.
 */

const cache = new Map<string, string>();

const OPTS = {
  lang: "eng",
  oem: 1,
  psm: 6, // assume a uniform block of text
};

/** OCR an uploaded image buffer (bet-slip screenshots). */
export async function ocrBuffer(buf: Buffer): Promise<string> {
  try {
    return (await tesseract.recognize(buf, OPTS)).trim();
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
    const text = (await tesseract.recognize(buf, OPTS)).trim();
    if (cache.size > 500) cache.clear(); // simple bound
    cache.set(url, text);
    return text;
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}
