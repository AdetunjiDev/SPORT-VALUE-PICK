import { verifyPending } from "./verifier.js";
import { prisma } from "@sportybet/db";

// One-shot verification pass for CLI/debugging.
(async () => {
  console.log("Verifying pending codes against SportyBet's official API…\n");
  const { verified, active } = await verifyPending(50);
  console.log(`\nVerified ${verified} codes · ${active} currently ACTIVE.`);
  await prisma.$disconnect();
})();
