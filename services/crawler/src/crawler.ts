import { prisma } from "@sportybet/db";
import { fetchSource } from "./adapters/index.js";
import { extract, contentHash } from "./extractor.js";
import { ocrImage } from "./ocr.js";

export interface CrawlResult {
  sourceId: string;
  sourceName: string;
  itemsFound: number;
  codesFound: number;
  codesNew: number;
  error?: string;
}

/** Basic source-reliability → star seed. Verification refines this later. */
function seedScore(trustScore: number, totalOdds?: number) {
  const reliability = Math.max(0, Math.min(1, trustScore));
  const stars = Math.round(1 + reliability * 4); // 1..5
  const risk = totalOdds && totalOdds > 20 ? "HIGH" : totalOdds && totalOdds > 8 ? "MEDIUM" : "LOW";
  return { reliability, stars, risk: risk as "LOW" | "MEDIUM" | "HIGH" };
}

/** Crawl a single source end-to-end and persist discovered codes. */
export async function crawlSource(source: {
  id: string;
  name: string;
  type: string;
  url: string;
  config: unknown;
  trustScore: number;
}): Promise<CrawlResult> {
  const startedAt = Date.now();
  const run = await prisma.crawlRun.create({
    data: { sourceId: source.id, status: "RUNNING" },
  });

  const result: CrawlResult = {
    sourceId: source.id,
    sourceName: source.name,
    itemsFound: 0,
    codesFound: 0,
    codesNew: 0,
  };

  try {
    const items = await fetchSource(source);
    result.itemsFound = items.length;
    const aggressive = source.type === "TELEGRAM";

    // OCR image messages (bounded per source per cycle; cached across cycles).
    let ocrBudget = 4;
    for (const item of items) {
      if (item.imageUrl && !item.content && ocrBudget > 0) {
        ocrBudget -= 1;
        item.content = await ocrImage(item.imageUrl);
      }
    }

    for (const item of items) {
      if (!item.content) continue; // skip images that OCR'd to nothing
      const info = extract(item.content, { aggressive });
      result.codesFound += info.codes.length;

      for (const code of info.codes) {
        const hash = contentHash(code, item.publishedAt);
        const { reliability, stars, risk } = seedScore(source.trustScore, info.totalOdds);
        const existing = await prisma.humanCode.findUnique({
          where: { contentHash: hash },
          select: { id: true },
        });

        if (existing) {
          // Refresh fields we may have just parsed better (odds/type), latest wins.
          await prisma.humanCode.update({
            where: { contentHash: hash },
            data: {
              totalOdds: info.totalOdds ?? undefined,
              numberOfGames: info.numberOfGames ?? undefined,
              codeType: info.codeType !== "UNKNOWN" ? info.codeType : undefined,
            },
          });
          continue;
        }

        try {
          await prisma.humanCode.create({
            data: {
              code,
              codeType: info.codeType,
              status: "UNVERIFIED",
              sourceId: source.id,
              originalUrl: item.url,
              author: item.author,
              title: item.title.slice(0, 500),
              rawContent: item.content.slice(0, 2000),
              totalOdds: info.totalOdds,
              numberOfGames: info.numberOfGames,
              datePublished: item.publishedAt ? new Date(item.publishedAt) : undefined,
              contentHash: hash,
              score: {
                create: {
                  stars,
                  confidencePct: Math.round(reliability * 100),
                  riskLevel: risk,
                  sourceReliability: reliability,
                },
              },
            },
          });
          result.codesNew += 1;
        } catch (e: any) {
          // Unique-constraint race on contentHash → already exists, ignore.
          if (e?.code !== "P2002") throw e;
        }
      }
    }

    await prisma.crawlRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCESS",
        itemsFound: result.itemsFound,
        itemsNew: result.codesNew,
        durationMs: Date.now() - startedAt,
        finishedAt: new Date(),
      },
    });
    await prisma.source.update({
      where: { id: source.id },
      data: { lastCrawledAt: new Date() },
    });
  } catch (err: any) {
    result.error = err?.message ?? String(err);
    await prisma.crawlRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        errorMessage: result.error?.slice(0, 500),
        durationMs: Date.now() - startedAt,
        finishedAt: new Date(),
      },
    });
  }

  return result;
}

/** Crawl every enabled, active source once. */
export async function crawlAll(): Promise<CrawlResult[]> {
  const sources = await prisma.source.findMany({
    where: { enabled: true, status: "ACTIVE" },
  });

  const results: CrawlResult[] = [];
  for (const s of sources) {
    const r = await crawlSource({
      id: s.id,
      name: s.name,
      type: s.type,
      url: s.url,
      config: s.config,
      trustScore: s.trustScore,
    });
    results.push(r);
    // Small courtesy delay between sources to stay polite.
    await new Promise((res) => setTimeout(res, 800));
  }
  return results;
}
