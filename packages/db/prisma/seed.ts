/**
 * Seed: an admin user + the default COMPLIANT crawl sources.
 * These sources use sanctioned/public data paths only
 * (Google News RSS, Reddit public JSON, YouTube search RSS,
 * and generic RSS feeds) — no ToS-violating scraping.
 */
import { PrismaClient, Role, SourceType } from "@prisma/client";
import { createHash } from "node:crypto";

const prisma = new PrismaClient();

// SportyBet booking-code search keywords (used to build query sources).
const KEYWORDS = [
  "SportyBet booking code today",
  "SportyBet free booking code",
  "SportyBet weekend booking code",
  "SportyBet daily booking code",
  "SportyBet VIP booking code",
  "SportyBet accumulator code",
];

function googleNewsRss(query: string): string {
  const q = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${q}&hl=en-NG&gl=NG&ceid=NG:en`;
}

function redditSearch(query: string): string {
  const q = encodeURIComponent(query);
  return `https://www.reddit.com/search.json?q=${q}&sort=new&limit=25`;
}

async function main() {
  // --- Admin user (password set via app later / OAuth) ---
  const adminEmail = "admin@sportybet-ai.local";
  await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      name: "Platform Admin",
      role: Role.ADMIN,
      emailVerified: true,
    },
  });

  // --- Google News RSS sources (one per keyword) ---
  for (const kw of KEYWORDS) {
    const url = googleNewsRss(kw);
    await prisma.source.upsert({
      where: { type_url: { type: SourceType.GOOGLE_NEWS, url } },
      update: { enabled: true },
      create: {
        name: `Google News · ${kw}`,
        type: SourceType.GOOGLE_NEWS,
        url,
        trustScore: 0.6,
        crawlIntervalSec: 180,
        config: { query: kw },
      },
    });
  }

  // --- Reddit betting subs (public JSON) ---
  const redditQueries = [
    "sportybet booking code",
    "sportybet code",
  ];
  for (const q of redditQueries) {
    const url = redditSearch(q);
    await prisma.source.upsert({
      where: { type_url: { type: SourceType.REDDIT, url } },
      update: { enabled: true },
      create: {
        name: `Reddit search · ${q}`,
        type: SourceType.REDDIT,
        url,
        trustScore: 0.45,
        crawlIntervalSec: 240,
        config: { query: q },
      },
    });
  }

  // --- Telegram public channel previews (t.me/s/<channel>, no auth) ---
  // These post real SportyBet booking codes on their PUBLIC preview pages.
  const telegramChannels: { channel: string; trust: number }[] = [
    { channel: "SportybetOfficialChannel", trust: 0.9 }, // official
    { channel: "bookingcodes", trust: 0.65 },
    // NOTE: "sportybetcodes" (plural) is an invalid/dead username on Telegram —
    // removed in favour of "sportybetcode" (singular), which is the real one.
    { channel: "sportybetcode", trust: 0.5 },
    { channel: "SportyBet_Codes", trust: 0.5 },
    { channel: "betfuse", trust: 0.5 },
    { channel: "sportybetng", trust: 0.55 },
  ];
  for (const { channel, trust } of telegramChannels) {
    const url = `https://t.me/s/${channel}`;
    await prisma.source.upsert({
      where: { type_url: { type: SourceType.TELEGRAM, url } },
      update: { enabled: true, trustScore: trust },
      create: {
        name: `Telegram · @${channel}`,
        type: SourceType.TELEGRAM,
        url,
        trustScore: trust,
        crawlIntervalSec: 180,
        config: { channel },
      },
    });
  }

  // --- A couple of generic RSS feed placeholders (edit in admin) ---
  const rssFeeds: { name: string; url: string }[] = [
    // Add real prediction-blog RSS feeds here via the admin dashboard.
  ];
  for (const feed of rssFeeds) {
    await prisma.source.upsert({
      where: { type_url: { type: SourceType.RSS, url: feed.url } },
      update: {},
      create: {
        name: feed.name,
        type: SourceType.RSS,
        url: feed.url,
        trustScore: 0.5,
      },
    });
  }

  const count = await prisma.source.count();
  console.log(`Seed complete. ${count} sources registered.`);
  // contentHash helper exposed for reference by crawler:
  void createHash;
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
