# apps/

Deployable applications. Added in later increments:

- **web/** — Next.js 14 + TS + Tailwind + shadcn/ui. User & Admin dashboards.
- **api/** — NestJS. Auth (JWT/OAuth), REST endpoints, BullMQ producers.

Each app consumes the workspace packages `@sportybet/db` and `@sportybet/shared`.
