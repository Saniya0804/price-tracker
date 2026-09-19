# Price Tracker — INE Store Scraper Assignment

Tracks products on INE's mock store (https://demo.inelabteamdev.com), scraping
price and stock every 2 hours, with an honest scrape log and price history.

## Architecture

- **Frontend**: React + Vite, deployed on Vercel. Search, track, dashboard,
  per-product price chart (Recharts) and scrape log table.
- **Backend**: Node.js + Express, deployed on Render. Exposes REST endpoints
  and a `/api/scrape/run` endpoint triggered by an external cron.
- **Database**: Supabase (Postgres) — `products`, `price_history`, `scrape_logs`.
- **Scraper**: Playwright (headless Chromium). The mock store gates its price
  behind a challenge → session → price handshake involving a WASM
  proof-of-work puzzle and an encrypted response payload, so the price is not
  present in the raw HTML. A real (headless) browser is used because it
  executes the page's own JavaScript to solve that handshake, rather than
  reverse-engineering the encryption. See `DESIGN_NOTE.md` for the reasoning.
- **Scheduling**: cron-job.org calls `POST /api/scrape/run` every 2 hours
  (Render's free tier sleeps when idle, so an external cron — not an in-process
  timer — is what actually drives scraping).

## Repo layout

```
backend/    Express API + Playwright scraper
frontend/   React app
supabase_schema.sql   Run this in Supabase's SQL editor first
DESIGN_NOTE.md
```

## Setup — Supabase

1. Create a free project at supabase.com.
2. Open SQL Editor → paste the contents of `supabase_schema.sql` → run.
3. Copy your Project URL and `service_role` key (Project Settings → API) —
   you'll need these for the backend `.env`.

## One-time step: build the search catalog

The store has no search of its own — you browse ~1000 products across 50
pages. Before search will return anything, crawl the catalog once:

```bash
curl -X POST http://localhost:4000/api/catalog/refresh -H "x-cron-secret: YOUR_CRON_SECRET"
```

This opens a real (headless) browser, pages through the store, and caches
every product's name/brand/sku/url into Supabase's `catalog` table. Re-run
this occasionally (e.g. add a second cron-job.org job, daily) to pick up any
new/changed products — `/api/search` always reads from this cache, never the
live store, so search stays instant.

## Setup — Backend (local)

```bash
cd backend
cp .env.example .env
# fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET
npm install
npx playwright install chromium   # downloads the browser binary
npm run dev
```

Server runs on `http://localhost:4000`.

To watch the scraper run in a visible browser window (for the demo recording):

```bash
npm run scrape:headed
```

This requires at least one product already tracked (track one via the
frontend first, then click **Scrape now** on its page, or run the headed
command). On Windows the headed script is `node src/headedRun.js` — the npm
script already does that.

You can also scrape without the UI:

```bash
npm run scrape
```

## Setup — Frontend (local)

```bash
cd frontend
cp .env.example .env
# VITE_API_BASE_URL=http://localhost:4000
npm install
npm run dev
```

Opens on `http://localhost:5173`.

## Deploying

**Backend → Render**
1. New Web Service, connect the repo, root directory `backend`.
2. Build command: `npm install && npx playwright install --with-deps chromium`
3. Start command: `npm start`
4. Add the same env vars as `.env.example` in Render's dashboard.
5. Note the deployed URL, e.g. `https://price-tracker-backend.onrender.com`.

**Frontend → Vercel**
1. New Project, connect the repo, root directory `frontend`.
2. Framework preset: Vite.
3. Add env var `VITE_API_BASE_URL` = your Render backend URL.
4. Deploy.

**Cron → cron-job.org**
1. Create a job: URL = `https://YOUR-BACKEND.onrender.com/api/scrape/run`
2. Method: POST
3. Header: `x-cron-secret: <same value as CRON_SECRET in backend .env>`
4. Schedule: every 2 hours.
5. (Optional) create a second job pinging `/api/health` every 10–14 minutes
   to reduce Render cold-start delay.

## Environment variables

| Var | Where | Purpose |
|---|---|---|
| `SUPABASE_URL` | backend | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | backend | Server-side Supabase key (never expose to frontend) |
| `STORE_BASE_URL` | backend | Mock store base URL |
| `CRON_SECRET` | backend | Shared secret cron-job.org must send to trigger scrapes |
| `HEADLESS` | backend | `true` in production, `false` for the demo recording |
| `SCRAPE_MAX_ATTEMPTS` | backend | Retry attempts per product per run |
| `SCRAPE_RETRY_BASE_MS` | backend | Base delay for exponential backoff |
| `SCRAPE_NAV_TIMEOUT_MS` | backend | Page navigation timeout |
| `SCRAPE_PRICE_WAIT_MS` | backend | How long to wait for the price to render after reveal/refresh |
| `VITE_API_BASE_URL` | frontend | URL of the deployed backend |

## Scrape schedule

Every 2 hours, via cron-job.org calling `POST /api/scrape/run`. Each tracked
product gets up to `SCRAPE_MAX_ATTEMPTS` attempts with exponential backoff;
every attempt (success, retried, or failed) is written to `scrape_logs`.
`price_history` only receives a row on a fully validated success — failed
attempts never write a price.

## Important note on how the price is read

The store hides the real price behind two anti-scraping tricks: decoy hidden
elements with plausible-looking but incorrect values, and a scrambled-digit
custom font on the real visible price. Because of this, the scraper does not
read the price as text — it screenshots the price element with Playwright and
runs OCR (`tesseract.js`) on the image, the same way a human eye reads it.
See `DESIGN_NOTE.md` for the full investigation. `npm install` pulls in
`tesseract.js` automatically; no extra setup is needed beyond
`npx playwright install chromium`.
