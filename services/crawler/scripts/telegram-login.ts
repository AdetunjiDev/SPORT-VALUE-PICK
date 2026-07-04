/**
 * One-time Telegram login → prints a StringSession to paste into .env.
 *
 * Run once on your own machine (NOT in Docker — it needs interactive input):
 *   1. Get api_id + api_hash from https://my.telegram.org → API development tools
 *   2. Put them in .env:  TELEGRAM_API_ID=...   TELEGRAM_API_HASH=...
 *   3. From the repo root:  pnpm --filter @sportybet/crawler telegram:login
 *   4. Enter your phone (with country code, e.g. +2348012345678), the code
 *      Telegram sends you, and your 2FA password if you have one.
 *   5. Copy the printed session string into .env as TELEGRAM_SESSION=...
 *   6. Rebuild the crawler:  docker compose up -d --build crawler
 *
 * The session string is a long-lived credential — treat it like a password,
 * never commit it. Use a dedicated number; automating a user account is a
 * Telegram ToS grey area, so read politely and don't hammer it.
 */
import { createInterface } from "node:readline/promises";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const apiId = Number(process.env.TELEGRAM_API_ID ?? 0);
const apiHash = process.env.TELEGRAM_API_HASH ?? "";

if (!apiId || !apiHash) {
  console.error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env first (from my.telegram.org).");
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => rl.question(q);

const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
  connectionRetries: 5,
});

await client.start({
  phoneNumber: async () => (await ask("Phone number (e.g. +2348012345678): ")).trim(),
  password: async () => (await ask("2FA password (blank if none): ")).trim(),
  phoneCode: async () => (await ask("Login code Telegram just sent you: ")).trim(),
  onError: (err) => console.error("Login error:", err?.message ?? err),
});

console.log("\n✅ Logged in. Copy this into your .env as TELEGRAM_SESSION=\n");
console.log((client.session.save() as unknown as string) ?? "");
console.log("\n(Keep it secret — it is a full login credential.)\n");

await client.disconnect();
await rl.close();
process.exit(0);
