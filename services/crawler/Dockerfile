# Crawler service — always-on 3-minute scanner + dashboard.
# Built from the monorepo root (context: .).
FROM node:20-slim

# Prisma needs openssl at runtime.
RUN apt-get update -y && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable

WORKDIR /app

# 1) Manifests first (better layer caching for installs).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/db/package.json ./packages/db/
COPY packages/shared/package.json ./packages/shared/
COPY services/crawler/package.json ./services/crawler/
RUN pnpm install --frozen-lockfile

# 2) Sources.
COPY packages ./packages
COPY services/crawler ./services/crawler

# 3) Generate Prisma client for the container platform.
RUN pnpm --filter @sportybet/db generate

WORKDIR /app/services/crawler
EXPOSE 4100
# Env is injected by docker-compose (no dotenv-cli needed here).
CMD ["pnpm", "start:docker"]
