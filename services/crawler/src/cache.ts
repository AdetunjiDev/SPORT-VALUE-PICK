import Redis from "ioredis";
import { config } from "./config.js";

// Backs expensive, request-independent computations (dashboard "recommended"
// picks, Expert Picks) with a short-lived cache so N concurrent visitors
// trigger the underlying analysis once, not N times. Falls back to computing
// fresh on every call when REDIS_URL isn't set or Redis is unreachable — a
// cache outage degrades to "slow like before", never a hard failure.
const client: Redis | null = config.redisUrl
  ? new Redis(config.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    })
  : null;

// ioredis throws if an 'error' listener isn't attached — this keeps a down
// Redis from crashing the whole process.
client?.on("error", (err) => {
  console.warn("[cache] redis unavailable:", err instanceof Error ? err.message : err);
});

// In-process de-dupe: while the first caller for a key is computing (cache
// miss), later callers for the SAME key await that same in-flight promise
// instead of starting their own redundant computation. This is what actually
// stops a burst of concurrent requests from all hammering the same expensive
// work at once, independent of Redis being present at all.
const inFlight = new Map<string, Promise<unknown>>();

export async function cached<T>(key: string, ttlSec: number, compute: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key);
  if (running) return running as Promise<T>;

  const run = (async (): Promise<T> => {
    if (client) {
      try {
        const hit = await client.get(key);
        if (hit != null) return JSON.parse(hit) as T;
      } catch {
        // Redis down/unreachable — fall through to computing directly.
      }
    }
    const value = await compute();
    void client?.set(key, JSON.stringify(value), "EX", ttlSec).catch(() => {});
    return value;
  })();

  inFlight.set(key, run);
  try {
    return await run;
  } finally {
    inFlight.delete(key);
  }
}
