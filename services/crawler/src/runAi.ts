import { generateAiSlips } from "./ai.js";
import { prisma } from "@sportybet/db";

(async () => {
  console.log("Generating AI bet slips from verified selection odds…\n");
  const n = await generateAiSlips();
  const slips = await prisma.aiBetSlip.findMany({ orderBy: { totalOdds: "asc" } });
  console.log(`Created ${n} AI slips:`);
  for (const s of slips) {
    console.log(
      `  ${s.title}: odds ${s.totalOdds} · conf ${Math.round(s.confidence * 100)}% · EV ${(s.expectedValue * 100).toFixed(1)}% · Kelly ${s.kellyStakePct}% · legs ${(s.legs as any[])?.length}`,
    );
  }
  await prisma.$disconnect();
})();
