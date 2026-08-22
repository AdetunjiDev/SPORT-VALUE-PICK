// Paystack billing: one-off NGN passes (daily / weekly / monthly) that extend
// a user's subscription window. Flow:
//   POST /pay/init      → Paystack initialize → redirect to their checkout
//   GET  /pay/callback  → verify the reference server-side → grant
//   POST /paystack/webhook (charge.success, HMAC-sha512 signed) → grant
// Both callback and webhook call grantFromCharge(), which is idempotent on the
// Paystack reference — a payment can never be credited twice.
import { createHmac } from "node:crypto";
import { prisma } from "@sportybet/db";
import { config } from "./config.js";

export type PlanId = "daily" | "weekly" | "monthly";

export const PLANS: Record<
  PlanId,
  { label: string; days: number; ngn: number; subPlan: "BASIC" | "PRO" | "VIP" }
> = {
  daily: { label: "Daily Pass", days: 1, ngn: config.paystack.planNgn.daily, subPlan: "BASIC" },
  weekly: { label: "Weekly", days: 7, ngn: config.paystack.planNgn.weekly, subPlan: "PRO" },
  monthly: { label: "Monthly", days: 30, ngn: config.paystack.planNgn.monthly, subPlan: "VIP" },
};

export function validPlan(v: unknown): PlanId | null {
  return v === "daily" || v === "weekly" || v === "monthly" ? v : null;
}

export function paystackEnabled(): boolean {
  return !!config.paystack.secretKey;
}

const PAYSTACK_API = "https://api.paystack.co";

async function paystack(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${PAYSTACK_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.paystack.secretKey}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || body?.status === false) {
    throw new Error(`Paystack ${path} failed (${res.status}): ${body?.message ?? "unknown error"}`);
  }
  return body;
}

/** Create a Paystack checkout session and a PENDING payment row. Returns the hosted checkout URL. */
export async function initTransaction(
  userId: string,
  email: string,
  planId: PlanId,
  callbackUrl: string,
): Promise<{ url: string; reference: string }> {
  const plan = PLANS[planId];
  const body = await paystack("/transaction/initialize", {
    method: "POST",
    body: JSON.stringify({
      email,
      amount: Math.round(plan.ngn * 100), // kobo
      currency: "NGN",
      callback_url: callbackUrl,
      metadata: { userId, planId, app: "sportybet-ai" },
    }),
  });
  const reference: string = body.data.reference;
  await prisma.payment.create({
    data: {
      userId,
      provider: "PAYSTACK",
      providerRef: reference,
      amount: plan.ngn.toFixed(2),
      currency: "NGN",
      status: "PENDING",
      plan: plan.subPlan,
      metadata: { planId },
    },
  });
  return { url: body.data.authorization_url as string, reference };
}

/** True when the raw webhook body was signed with our Paystack secret key. */
export function webhookSignatureValid(rawBody: string, signature: string | string[] | undefined): boolean {
  if (!signature || Array.isArray(signature) || !config.paystack.secretKey) return false;
  const expected = createHmac("sha512", config.paystack.secretKey).update(rawBody).digest("hex");
  return signature === expected;
}

/**
 * Credit a successful charge: mark the payment SUCCEEDED and extend the user's
 * subscription window. Idempotent on the Paystack reference. Returns false when
 * the charge doesn't check out (bad metadata, short-paid amount, unknown user).
 */
export async function grantFromCharge(data: {
  reference?: string;
  amount?: number; // kobo, as reported by Paystack
  status?: string;
  metadata?: { userId?: string; planId?: string } | null;
}): Promise<boolean> {
  const reference = data.reference;
  const planId = validPlan(data.metadata?.planId);
  const userId = data.metadata?.userId;
  if (!reference || !planId || !userId) return false;
  const plan = PLANS[planId];
  // Reject short payments (e.g. a replayed cheaper charge with edited metadata).
  if (typeof data.amount !== "number" || data.amount < Math.round(plan.ngn * 100)) return false;

  const existing = await prisma.payment.findUnique({ where: { providerRef: reference } });
  if (existing?.status === "SUCCEEDED") return true; // already credited
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { subscription: true } });
  if (!user) return false;

  await prisma.payment.upsert({
    where: { providerRef: reference },
    update: { status: "SUCCEEDED" },
    create: {
      userId,
      provider: "PAYSTACK",
      providerRef: reference,
      amount: (data.amount / 100).toFixed(2),
      currency: "NGN",
      status: "SUCCEEDED",
      plan: plan.subPlan,
      metadata: { planId },
    },
  });

  // Extend from the current expiry when still active, else from now.
  const now = Date.now();
  const currentEnd = user.subscription?.currentPeriodEnd?.getTime() ?? 0;
  const base = currentEnd > now ? currentEnd : now;
  const newEnd = new Date(base + plan.days * 86_400_000);
  await prisma.subscription.upsert({
    where: { userId },
    update: { plan: plan.subPlan, status: "ACTIVE", provider: "PAYSTACK", currentPeriodEnd: newEnd },
    create: {
      userId,
      plan: plan.subPlan,
      status: "ACTIVE",
      provider: "PAYSTACK",
      currentPeriodEnd: newEnd,
    },
  });
  console.log(`[billing] ${user.email} +${plan.days}d premium (${planId}, ref ${reference}) → ${newEnd.toISOString()}`);
  return true;
}

/** Verify a reference with Paystack (server-to-server) and credit it if successful. */
export async function verifyAndGrant(reference: string): Promise<boolean> {
  if (!paystackEnabled()) return false;
  const body = await paystack(`/transaction/verify/${encodeURIComponent(reference)}`);
  if (body?.data?.status !== "success") return false;
  return grantFromCharge(body.data);
}

// =====================================================================
// OWNER METRICS — the numbers a buyer / advertiser actually asks for.
// =====================================================================
export interface BusinessMetrics {
  totalUsers: number;
  newUsers7: number;
  newUsers30: number;
  activeSubscribers: number;
  paidCount: number; // successful payments, all-time
  revenueAllNgn: number; // sum of SUCCEEDED NGN payments
  revenue30Ngn: number; // trailing 30 days (proxy for current monthly revenue)
  planCounts: { daily: number; weekly: number; monthly: number };
  recent: { email: string; amountNgn: number; plan: PlanId | "—"; at: Date }[];
  paystackLive: boolean;
}

// SubscriptionPlan (VIP/PRO/BASIC) → the pass the customer bought.
const PLAN_FROM_SUB: Record<string, PlanId> = { BASIC: "daily", PRO: "weekly", VIP: "monthly" };

/** Aggregate users, active subscriptions and revenue for the admin metrics view. */
export async function getBusinessMetrics(): Promise<BusinessMetrics> {
  const now = new Date();
  const d7 = new Date(Date.now() - 7 * 86_400_000);
  const d30 = new Date(Date.now() - 30 * 86_400_000);

  const [totalUsers, newUsers7, newUsers30, activeSubscribers, succeeded, recentRows] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: d7 } } }),
    prisma.user.count({ where: { createdAt: { gte: d30 } } }),
    prisma.subscription.count({
      where: { status: { in: ["ACTIVE", "TRIALING"] }, currentPeriodEnd: { gt: now } },
    }),
    prisma.payment.findMany({
      where: { status: "SUCCEEDED", currency: "NGN" },
      select: { amount: true, plan: true, createdAt: true },
    }),
    prisma.payment.findMany({
      where: { status: "SUCCEEDED" },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { amount: true, plan: true, createdAt: true, user: { select: { email: true } } },
    }),
  ]);

  const revenueAllNgn = succeeded.reduce((a, p) => a + Number(p.amount), 0);
  const revenue30Ngn = succeeded
    .filter((p) => p.createdAt >= d30)
    .reduce((a, p) => a + Number(p.amount), 0);
  const planCounts = { daily: 0, weekly: 0, monthly: 0 };
  for (const p of succeeded) {
    const id = p.plan ? PLAN_FROM_SUB[p.plan] : undefined;
    if (id) planCounts[id] += 1;
  }
  const recent = recentRows.map((p) => ({
    email: p.user?.email ?? "—",
    amountNgn: Number(p.amount),
    plan: (p.plan ? PLAN_FROM_SUB[p.plan] : undefined) ?? ("—" as const),
    at: p.createdAt,
  }));

  return {
    totalUsers,
    newUsers7,
    newUsers30,
    activeSubscribers,
    paidCount: succeeded.length,
    revenueAllNgn: Math.round(revenueAllNgn),
    revenue30Ngn: Math.round(revenue30Ngn),
    planCounts,
    recent,
    paystackLive: paystackEnabled(),
  };
}
