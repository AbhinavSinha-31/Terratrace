# TerraTrace → production: roadmap

Status: roadmap from the user, 2026-10-25. Branch `production` (from `quickscan` at `779fe28`). It builds on
[QUICKSCAN_PLAN.md](QUICKSCAN_PLAN.md) and keeps its rules: quick-scan numbers are "public datasets, not validated for
this area", never a TerraTrace classification; nothing is simulated; Earth Engine credentials stay on the server.

Four phases, in this order. Each step ends with typecheck, build and the full backend suite green, and a commit.

| Phase | Goal | Status |
|---|---|---|
| 1 | Analysis features: land cover (LULC), surface temperature / heat island (LST/UHI) map, carbon — for every scanned area | Mostly built as the quick scan (see below) |
| 2 | Production hardening + deploy readiness | In progress (checklist below) |
| 3 | Supabase auth (Google + email), user profiles, saved analyses | Not started |
| 4 | Community: Quora/Reddit-style discussions on reports, voting, tags, moderation | Not started |

**Other drafts.** Two untracked drafts were written in the main working tree on 2026-10-25 by another session:
`PLAN.md` (8 phases, Supabase) and `docs/COMMUNITY_PLAN.md` (community on **SQLite with email + password only**).
This roadmap supersedes their phase numbering. COMMUNITY_PLAN.md's storage and sign-in decisions contradict
Phase 3 here (Supabase, Google + email) and need the user's confirmation before either is built.

## Phase 1 — analysis features: what the quick scan already does

Checked against the code on `quickscan` (`backend/app/providers/earth_engine/quickscan.py`,
`backend/app/services/quickscan.py`, `frontend/src/features/quickscan/`).

| Asked for | Already built | Gap |
|---|---|---|
| LULC classes | Dynamic World V1 annual composite: 9 classes, area per class, low-confidence share (top probability < 0.5), cross-check with ESA WorldCover 2021 (reported as agreement, not accuracy); map layer with Dynamic World colours | It is Dynamic World's classification, not a TerraTrace classifier. The custom Random Forest stays in the research tier (`analysis/`), by decision of 2026-10-21 |
| LST / UHI heatmap | Landsat 8/9 C2 L2 surface temperature, the research pipeline's masks; per-class mean LST; "simple surface UHI (built − non-built, water excluded)" when built-up land is ≥ 5 % and ≥ 2 km²; LST map layer (inferno, area's own 2nd–98th percentile) | The map is LST, not a UHI-anomaly layer (LST minus a rural reference). A separate anomaly layer would be a method change (version bump) |
| Carbon index | ESA CCI above-ground biomass 2022 × 0.47 → t C/ha, total and range; map layer 0–150 t C/ha | Labelled "above-ground tree biomass carbon (ESA CCI)" — a density, not an index; excludes soil (decision 2026-10-21). Soil carbon can be added as a second component |
| For every scanned area | Any searched or drawn area up to 1,500 km², behind the "Run quick scan" button (never automatic, by decision); cached per area/year/season | Not merged into `main`; **no live run yet** (offline, mocked tests only); with Phase 3, scans would need sign-in and per-user daily limits |

**Remaining Phase 1 work:** first live scan of one small area (~50 km², with the user's OK — Earth Engine is in
restricted mode), merge `quickscan` into `main`, then decide whether a UHI-anomaly layer is wanted.

## Phase 2 — production hardening + deploy readiness

Deploy itself waits for the user's choice of backend host (see "Backend hosting" below).

| # | Item | Status |
|---|---|---|
| 2.1 | No mock / demo data in the code | Done before this phase (demo generator deleted 2026-09-27; re-checked 2026-10-25) |
| 2.2 | Hardcoded numbers on featured and case-study pages traced to a source | See [HARDCODED_NUMBERS_AUDIT.md](HARDCODED_NUMBERS_AUDIT.md) |
| 2.3 | API keys server-side only; no secret in the frontend bundle | Verified 2026-10-25 (fresh build scanned; only `VITE_API_BASE` is read) |
| 2.4 | Input validation, rate limiting, error boundaries, loading / empty states | Validation, limits, error boundary and state views exist; tile routes rate-limited 2026-10-25 (`TT_RATE_TILES_PER_MIN`) |
| 2.5 | Tests for the important flows | Backend: analysis, quick scan, jobs, tiles, chat, limits. Frontend unit tests (this phase). Auth / posting / voting: skipped until Phases 3–4 |
| 2.6 | Accessibility, mobile, Lighthouse | This phase; report in [LIGHTHOUSE_REPORT.md](LIGHTHOUSE_REPORT.md) |
| 2.7 | Bundle size: lazy-load MapLibre and heavy pages | This phase |
| 2.8 | Gemini free tier: notice next to the chat (content may be reviewed, 18+), switch to a paid key by configuration | Done 2026-10-25: `TT_LLM_TIER=free\|paid`, notice from `/api/health` `chat.tier`; the paid tier itself is still to buy (PRE_DEPLOYMENT #4–5) |
| 2.9 | Backend deploy-ready: Dockerfile, health check, `--proxy-headers`, configurable cache paths | Done 2026-10-25: root `Dockerfile` + `.dockerignore`, `GET /api/health/live`, `TT_CACHE_DIR` + new `TT_TILE_CACHE_DIR`. Image not built here (no Docker on this machine); layout checked by running the app from a copy of the image's folders |
| 2.10 | Deploy frontend to Vercel, set environment variables | Waiting for the backend host decision |
| 2.11 | README | Updated with each step |

## Backend hosting — options

What the backend needs (unchanged since 2026-10-09): **one long-running process** (analysis and quick-scan jobs run
for minutes in background threads and are polled from memory; a 15-minute quick scan in restricted mode is possible),
**a persistent disk** for `TT_CACHE_DIR` (registered areas, stored results, quick scans — losing them means
recomputing in Earth Engine) and a disposable tile cache, **exactly one instance** (rate limits and jobs are
per-process), and ~250 MB of Python dependencies. HTTP requests themselves are short: jobs are started and then polled.

| | Railway | Render | Google Cloud Run |
|---|---|---|---|
| Long background jobs | Fine: a normal always-on container. Serverless sleep is opt-in; leave it off | Fine on a **paid** instance. Free instances sleep after 15 min without traffic (≈1 min to wake), which kills in-memory jobs | Needs **instance-based billing** (CPU outside requests) **and min instances = 1, max = 1**; otherwise background threads are throttled or the instance is stopped |
| Persistent disk for the cache | Volume on Hobby (5 GB) and Pro (50 GB+); short downtime on each redeploy; no replicas with a volume | Persistent disk on paid services only; no zero-downtime deploys and no scaling beyond one instance with a disk | No block disk. Cloud Storage FUSE volume: not POSIX, no file locking, slow listings — fine for the JSON results, poor for thousands of small tiles. Put tiles on the in-memory filesystem (`TT_TILE_CACHE_DIR`, counts against RAM) |
| Earth Engine credentials | Service-account key as a secret file | Service-account key as a secret file | Best: the service can run **as** the Earth Engine service account, so no key file exists. Needs a small backend change first: `provider.initialize` accepts only a key file or `earthengine authenticate` credentials today |
| Rough cost | Hobby $5/month incl. $5 usage, then usage | $7/month instance + disk (per GB-month) | One always-on instance billed continuously (likely the most expensive of the three for 1 vCPU / 1–2 GiB) |
| Fit | **Simplest.** Closest to how the backend runs today | Equally good; free tier unusable | Best security story, most configuration |

**Recommendation:** Railway Hobby (or Render's $7 instance) with one volume mounted at `TT_CACHE_DIR`, unless keeping
Earth Engine keyless on Cloud Run matters more than simplicity. Prices change: check railway.com/pricing,
render.com/pricing and cloud.google.com/run/pricing before choosing.

Sources (read 2026-10-25): [Render disks](https://render.com/docs/disks), [Railway volumes](https://docs.railway.com/reference/volumes),
[Railway serverless](https://docs.railway.com/deployments/serverless),
[Cloud Run billing settings](https://docs.cloud.google.com/run/docs/configuring/cpu-allocation),
[Cloud Run Cloud Storage volumes](https://docs.cloud.google.com/run/docs/configuring/services/cloud-storage-volume-mounts).

## Phase 3 — Supabase auth, profiles, saved analyses (not started)

Google + email sign-in through Supabase Auth; backend verifies Supabase JWTs; profiles; saved areas and saved
analysis snapshots written **only by the backend** (so a saved number is always TerraTrace's own measurement);
per-user daily limits for quick scans and analyses. Tests for auth come with this phase.

## Phase 4 — community (not started)

Discussions anchored on reports (featured investigations, the case study, published analyses), answers and comments,
voting, tags, sorting, reports and an admin moderation queue. Community text is never a TerraTrace measurement and
never enters the chatbot's facts. Tests for posting and voting come with this phase.
