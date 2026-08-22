// User authentication: scrypt password hashing + HMAC-signed session cookies.
// No external deps — everything comes from node:crypto. Sessions are stateless
// (userId + expiry signed with a server secret), so no session table is needed
// and restarts don't log anyone out as long as SESSION_SECRET is stable.
import { createHmac, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

// ---- Password hashing (scrypt) ----
// Stored format: s2$<saltHex>$<hashHex>
const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `s2$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "s2") return false;
  try {
    const expected = Buffer.from(parts[2], "hex");
    const actual = scryptSync(password, parts[1], SCRYPT_KEYLEN);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// ---- Session tokens ----
// Format: <userId>.<expEpochSec>.<hmacHex>
const sessionSecret: string =
  config.sessionSecret ||
  (config.appPassword || config.adminKey
    ? createHash("sha256").update(`sbai-session:${config.appPassword}:${config.adminKey}`).digest("hex")
    : (() => {
        console.warn(
          "[auth] No SESSION_SECRET / APP_PASSWORD / ADMIN_KEY set — using a random per-boot session secret; user sessions reset on every restart.",
        );
        return randomBytes(32).toString("hex");
      })());

function sessionSig(payload: string): string {
  return createHmac("sha256", sessionSecret).update(payload).digest("hex");
}

export function signSession(userId: string, days = 30): string {
  const exp = Math.floor(Date.now() / 1000) + days * 86400;
  const payload = `${userId}.${exp}`;
  return `${payload}.${sessionSig(payload)}`;
}

/** Returns the userId if the token is valid and unexpired, else null. */
export function verifySession(token: string | null | undefined): string | null {
  if (!token) return null;
  const i = token.lastIndexOf(".");
  if (i <= 0) return null;
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expected = sessionSig(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const j = payload.lastIndexOf(".");
  if (j <= 0) return null;
  const exp = Number(payload.slice(j + 1));
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null;
  return payload.slice(0, j);
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  const m = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

// ---- Simple in-memory rate limiting (per IP, per action) ----
// Good enough for a single-process server; swap for Redis if this ever scales
// past one instance.
const buckets = new Map<string, { n: number; resetAt: number }>();

export function rateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt < now) {
    buckets.set(key, { n: 1, resetAt: now + windowMs });
    return false;
  }
  b.n += 1;
  if (buckets.size > 10_000) {
    // Bounded memory: drop expired buckets when the map grows large.
    for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
  }
  return b.n > max;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
