# Deploying SportyBet AI online (live 24/7)

The app is fully containerized, so "online" = run the same containers on an
always-on server. This guide uses a small VPS + Docker Compose, which behaves
**exactly like your local setup** (same images, same 3-minute scanner).

---

## 0. What you need

- A **VPS** (Ubuntu 22.04+). Good cheap options: Hetzner (~€4/mo), DigitalOcean
  ($6/mo), AWS Lightsail. 1 vCPU / 2 GB RAM is plenty.
- A **domain name** pointed at the server (an A record → server IP).
- 15 minutes.

> Prefer zero server management? A PaaS like **Railway** or **Render** can run
> the `crawler` Docker image + managed Postgres with a few clicks. This guide is
> the VPS path because it's the truest "works like local."

---

## 1. Create the server & DNS

1. Create the VPS, note its public IP.
2. In your domain's DNS, add an **A record**: `app.yourdomain.com → <server IP>`.

## 2. Install Docker on the server

```bash
ssh root@<server-ip>
curl -fsSL https://get.docker.com | sh
```

## 3. Get the code onto the server

```bash
# from your machine, or git clone if you push this repo to GitHub
git clone <your-repo-url> sportybet-ai && cd sportybet-ai
# (or: scp -r the project folder up)
```

## 4. Configure production secrets

```bash
cp .env.example .env
nano .env
```

Set **strong** values for:

```env
POSTGRES_USER=sportybet
POSTGRES_PASSWORD=<long-random-password>
POSTGRES_DB=sportybet
JWT_ACCESS_SECRET=<random>
JWT_REFRESH_SECRET=<random>

# Deployment
DOMAIN=app.yourdomain.com
ACME_EMAIL=you@example.com
```

Generate the dashboard login hash and paste it in:

```bash
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'YourDashboardPassword'
# copy the $2a$... output, then set:
#   DASH_BASICAUTH=admin <that-hash>
```

(Optional but recommended) add `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` to
unlock Reddit as a source.

## 5. Launch

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

This will: start Postgres + Redis → run migrations + seed sources → start the
crawler (3-minute scanner) → start Caddy, which fetches a free HTTPS certificate
for your domain automatically.

## 6. Verify

- Open **https://app.yourdomain.com** → browser asks for the dashboard password →
  you see the live codes, exactly like localhost:4100.
- Logs: `docker compose -f docker-compose.prod.yml logs -f crawler`

That's it — it now runs 24/7, rescans every 3 minutes, and auto-restarts on
reboot or crash.

---

## Important operational notes

### Datacenter-IP source blocking (read this)
Some sources block cloud/datacenter IPs:
- **Reddit** — already blocked without OAuth creds (expected).
- **Telegram `t.me/s/`** — worked from your home IP; from a datacenter it *may*
  get rate-limited. **Google News RSS** works fine from cloud.

If Telegram throttles on the server, route the crawler's outbound traffic through
a cheap **residential proxy** (set `HTTPS_PROXY` for the crawler service). We can
wire this in if/when it happens — don't pre-optimize.

### Compliance (before making it public)
A publicly reachable betting-tips site should have:
- an **18+ age gate** and jurisdiction notice,
- the **"estimates, not guarantees"** disclaimer (already rendered on the
  dashboard),
- respect for source ToS. Confirm your host allows gambling-related content
  (Hetzner/DO/Railway generally do — check their AUP).

### Backups
Postgres data lives in the `postgres_data` volume. Snapshot the VPS or run
`pg_dump` on a schedule for real deployments.

### Updating
```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
```
