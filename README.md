# LienRadar Platform

Internal South Florida auction intelligence app (Miami-Dade, Broward, Palm Beach, Monroe). **No fixture/mock lots.** Data appears only after live pulls succeed. Admin shows cron schedules and per-resource health (`OK` / `DOWN` / `NOT_CONFIGURED` / `DEGRADED`).

## Quick start (one script)

From the repo root on Windows:

```bat
lr setup
lr start
```

Or via npm:

```bash
npm run setup:local
npm run start:local
```

What `start` does: Postgres + **Redis** (`docker compose`), deps/build/db push+seed, Playwright Chromium, **ingest worker (cron)**, and **web** on http://localhost:3000.

Performance: lots list is SQL-filtered + paginated; dashboard/admin poll use short Redis TTLs; PA/GIS HTTP responses are Redis-cached (`REDIS_URL`).

```bat
lr status
lr stop
lr restart
lr stop -StopDb
```

Logs/PIDs live under `.cache/lienradar/`.

Login: `owner@lienradar.local` / `lienradar`

### Manual / one-shot worker jobs

```bash
npm run once -w @lienradar/ingest -- --once
npm run once -w @lienradar/ingest -- --once --job=calendar_6h
```

## Scheduled jobs

| Key | Cron (America/New_York) | Sources |
|-----|-------------------------|---------|
| `calendar_6h` | `15 */6 * * *` | RealTaxDeed + RealForeclose |
| `day_refresh_30m` | `*/30 * * * *` | RealTaxDeed + RealForeclose |
| `enrich_pa_6h` | `45 */6 * * *` | Property Appraiser ArcGIS |
| `enrich_clerk_nightly` | `30 3 * * *` | Clerk API (needs AuthKey) |
| `enrich_tax_nightly` | `50 3 * * *` | Tax Collector portal |
| `method_nightly` | `20 4 * * *` | BidGate recompute |
| `nightly` | `20 2 * * *` | Full cycle |

Open **Admin** to see last run status and resource errors.

## Env for locked resources

- `MIAMI_DADE_CLERK_AUTH_KEY` — Clerk Developers

Until that is set, Admin shows **NOT_CONFIGURED** for paid clerk paths. No fake rows are inserted.
