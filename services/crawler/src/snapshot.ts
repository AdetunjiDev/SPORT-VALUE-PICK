/**
 * Dashboard render snapshots for serverless (Netlify) hosts.
 *
 * Sync functions have ~10s before Netlify kills them. After each crawl we
 * upsert a single JSON row with the human-dashboard list/KPI data so HTTP
 * requests can skip the expensive recommended/expert recomputation.
 */
import { prisma } from "@sportybet/db";
import { telegramClientEnabled } from "./adapters/telegram-client.js";

export const DASHBOARD_HUMAN_SNAPSHOT_ID = "dashboard-human";

/** Snapshots older than this are treated as stale (crawl runs every ~3 min). */
export const SNAPSHOT_FRESH_MS = 10 * 60 * 1000;

export function isServerlessRuntime(): boolean {
  return Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);
}

export type HumanDashboardSnapshotPayload = {
  codes: unknown[];
  totalCodes: number;
  sourceCount: number;
  activeCount: number;
  dateRows: { d: string; n: number }[];
  tgChannels: number;
  tgApiLive: boolean;
  lastSummary: string;
  lastRunAt: string | null;
  aiSlips: unknown[];
};

export async function writeDashboardSnapshot(meta?: {
  lastRunAt?: Date | null;
  lastSummary?: string;
}): Promise<void> {
  const notInvalid = { status: { not: "INVALID" as const } };
  const [codes, totalCodes, sourceCount, aiSlips, activeCount, dateRows, tgChannels] =
    await Promise.all([
      prisma.humanCode.findMany({
        where: notInvalid,
        orderBy: { foundAt: "desc" },
        take: 150,
        include: { source: true, score: true },
      }),
      prisma.humanCode.count({ where: notInvalid }),
      prisma.source.count({ where: { enabled: true } }),
      prisma.aiBetSlip.findMany({ orderBy: { totalOdds: "asc" } }),
      prisma.humanCode.count({ where: { status: "ACTIVE" } }),
      prisma.$queryRaw<{ d: string; n: number }[]>`
        SELECT to_char("foundAt" AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD') AS d, count(*)::int AS n
        FROM human_codes WHERE status <> 'INVALID' GROUP BY 1 ORDER BY 1 DESC LIMIT 14`,
      prisma.source.count({ where: { enabled: true, type: "TELEGRAM" } }),
    ]);

  const payload: HumanDashboardSnapshotPayload = {
    codes: JSON.parse(JSON.stringify(codes)),
    totalCodes,
    sourceCount,
    activeCount,
    dateRows,
    tgChannels,
    tgApiLive: telegramClientEnabled(),
    lastSummary: meta?.lastSummary ?? "",
    lastRunAt: meta?.lastRunAt ? meta.lastRunAt.toISOString() : null,
    aiSlips: JSON.parse(JSON.stringify(aiSlips)),
  };

  await prisma.renderSnapshot.upsert({
    where: { id: DASHBOARD_HUMAN_SNAPSHOT_ID },
    create: { id: DASHBOARD_HUMAN_SNAPSHOT_ID, payload },
    update: { payload },
  });
}

export async function readDashboardSnapshot(): Promise<{
  payload: HumanDashboardSnapshotPayload;
  updatedAt: Date;
} | null> {
  try {
    const row = await prisma.renderSnapshot.findUnique({
      where: { id: DASHBOARD_HUMAN_SNAPSHOT_ID },
    });
    if (!row?.payload || typeof row.payload !== "object") return null;
    return {
      payload: row.payload as HumanDashboardSnapshotPayload,
      updatedAt: row.updatedAt,
    };
  } catch (err) {
    console.warn(
      "[snapshot] read failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export function snapshotIsFresh(updatedAt: Date, now = Date.now()): boolean {
  return now - updatedAt.getTime() <= SNAPSHOT_FRESH_MS;
}
