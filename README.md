# SportyBet AI Booking Code Intelligence

A cloud-native SaaS that discovers, verifies, analyses, ranks and recommends
**Human Booking Codes** and **AI-powered booking recommendations** for football.

> ⚠️ **Compliance:** Predictions are statistical **estimates, not guarantees**.
> The platform never fabricates or claims an official SportyBet booking code.
> 18+ only — bet responsibly. Data is gathered only through sanctioned/public
> paths (Google News RSS, Reddit public JSON, YouTube Data API, generic RSS,
> and paid search APIs) — no ToS-violating scraping.

## Monorepo layout

```
.
├─ apps/
│  ├─ web/        Next.js dashboards (user + admin)      [next increment]
│  └─ api/        NestJS API (auth, REST, queues)        [next increment]
├─ services/
│  ├─ crawler/    Source-adapter crawler + scheduler     [next increment]
│  └─ ml/         FastAPI prediction engine              [next increment]
├─ packages/
│  ├─ db/         Prisma schema + client (@sportybet/db)      ✅ this increment
│  └─ shared/     Shared types & constants (@sportybet/shared) ✅ this increment
├─ docker-compose.yml   Postgres + Redis (+ adminer)     ✅ this increment
└─ turbo.json / pnpm-workspace.yaml                      ✅ this increment
```

## Tech stack

| Layer      | Choice                                             |
| ---------- | -------------------------------------------------- |
| Frontend   | Next.js 14, React, TypeScript, Tailwind, shadcn/ui |
| API        | NestJS, Node.js                                    |
| ML         | Python, FastAPI, XGBoost/LightGBM, Poisson, Kelly  |
| Data       | PostgreSQL 16, Prisma ORM                           |
| Queue/Cache| Redis 7, BullMQ                                    |
| Auth       | JWT, Google OAuth, Apple Sign-In                   |
| Payments   | Stripe, Paystack, Flutterwave                      |
| Infra      | Docker, Kubernetes, NGINX, Cloudflare, AWS         |

## Getting started (foundation)

Prereqs: Node ≥ 20, pnpm ≥ 9, Docker Desktop.

```bash
# 1. Install workspace deps
pnpm install

# 2. Configure environment
cp .env.example .env        # edit secrets as needed

# 3. Start infrastructure (Postgres + Redis)
pnpm infra:up

# 4. Create the database schema
pnpm db:generate            # generate Prisma client
pnpm db:migrate             # create & apply the initial migration
pnpm db:seed                # register default compliant sources + admin

# Optional: browse the DB
pnpm db:studio              # Prisma Studio
# or the adminer UI:
docker compose --profile tools up -d adminer   # http://localhost:8080
```

Postgres: `localhost:5432` · Redis: `localhost:6379`.

## Roadmap (build increments)

1. **Foundation** — monorepo, Docker infra, full Prisma ER schema ✅
2. **Auth + API skeleton** — NestJS, JWT, first live endpoints
3. **Crawler v1** — compliant source adapters + BullMQ scheduler + dedupe/verify
4. **ML v1** — FastAPI Poisson model + EV/Kelly + calibration
5. **Dashboards** — user + admin, real-time, charts, exports

## License

Proprietary — commercial deployment. All rights reserved.
