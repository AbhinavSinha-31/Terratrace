# TerraTrace → production: plan

Status: **draft for approval** (2026-10-25). No code has been written for anything in this plan. Written on branch
`quickscan` (commit `779fe28`); it builds on the quick-scan work in `docs/QUICKSCAN_PLAN.md`.

## 0. Summary

- TerraTrace today is a **single-user, anonymous, file-backed prototype** with an unusually honest science core: every
  forest figure comes from a live Earth Engine run, and the code contains no fake numbers, demo data or TODO stubs.
- What blocks "production" is everything around that core: no accounts, no database, state kept in process memory
  and on local disk, a Gemini free-tier chatbot, Earth Engine run with a personal login, and a few hardcoded
  constants that will go stale.
- **Recommendation: Supabase** (Postgres + Auth + Row Level Security + Storage) for users, saved work and the
  community. **Keep the FastAPI backend** for Earth Engine on a long-running host. **Keep the Vite SPA** on Vercel.
  Section 2.1 explains why, and the alternatives.
- Eight phases, roughly **6–8 weeks** of focused work (section 4). Phase 0 can start without any Supabase account.

---

## 1. What works today, and what is mock, hardcoded or a placeholder

### 1.1 What works (verified this month)

| Area | State | Evidence |
|---|---|---|
| Forest-change analysis (Sentinel-2 + Dynamic World, Landsat imagery 1984–2015) | Live in Earth Engine, method `tt-ee-2.4`, validity rules, stored results | `backend/app/services/science.py:16`, `services/analysis.py` |
| Four featured investigations | Stored READY results, open in 0 s, no new jobs | checked 2026-10-21 |
| Any area: search or draw, analyse, context (DEM, Hansen, WorldCover) | Live, cached per area | `services/context.py` |
| Noida–Ghaziabad research case study | Static page, map tiles, PDF + CSV downloads; numbers match `results_summary.md` | `frontend/src/features/casestudy/`, `analysis/` |
| Quick scan: land cover (Dynamic World), surface temperature (Landsat), biomass carbon (ESA CCI) | Built and tested offline (branch `quickscan`, not merged); **no live run yet** | `backend/app/services/quickscan.py` |
| AI chat (Gemini) with a validator that withholds unverified numbers | Works; free tier | `backend/app/services/chat/` |
| Tests | Backend 586 passed / 4 skipped; analysis 20; typecheck + build OK | 2026-10-22 |

### 1.2 Mock / dummy / fake data

**None found.** A full search of `backend/app`, `frontend/src`, `analysis/` and the data files for
`TODO|FIXME|mock|fake|dummy|placeholder|stub|demo|simulat|hardcode` found only (a) honest-state messages such as
"TERRATRACE does not display estimated, simulated, or placeholder measurements" (`backend/app/errors.py:22`,
`frontend/src/data/client.ts:27`) and (b) HTML input placeholders. The demo generator was deleted on 2026-09-27.
Test fixtures (`backend/tests/test_quickscan.py`, `test_chat_quickscan.py`) are synthetic and never served.

### 1.3 Placeholders (UI that pretends a feature exists)

| # | Where | What | Fix (phase) |
|---|---|---|---|
| P1 | `frontend/src/features/shell/Header.tsx:193-218` | Avatar menu says "Local session · Not signed in · prototype build"; there is no account system | Real sign-in menu (1) |
| P2 | `frontend/src/features/shell/Header.tsx:131` | "System notices" bell shows backend health notices only (real, but users will expect notifications) | Keep; add reply notifications later (5) |

### 1.4 Hardcoded values that will go stale or must be configurable

| # | Where | Value | Risk | Fix (phase) |
|---|---|---|---|---|
| H1 | `frontend/src/lib/time.ts:9-18` and `backend/app/services/science.py:61-65` | `MODERN_YEARS` to 2025, `TIMELINE_END = PENDING_YEAR = 2026`, `DEFAULT_ANALYSIS_WINDOW` / `DEFAULT_EVENT_WINDOW = 2018–2025` (mirrored by hand in two places) | Stale from January 2027; the two copies can drift | Derive from the current date on the backend; serve via `/api/health` (0) |
| H2 | `backend/app/providers/earth_engine/provider.py:58,73`, `backend/app/services/context.py:41` | Hansen GFC `v1_13`, last loss year 2025, `range(2001, 2026)` | New Hansen release each year | One dataset-version config + a test that the asset exists (0) |
| H3 | `backend/app/services/imagery.py:45` | `GLOBE_MOSAIC_YEAR = 2025` (EOX s2cloudless) | Needs a yearly bump | Config value (0) |
| H4 | `backend/app/providers/earth_engine/quickscan.py:44,47` | `CCI_YEAR = 2022`, `WORLDCOVER_YEAR = 2021` | Fine (latest available); document | Config + catalogue check (0) |
| H5 | `backend/app/services/quickscan.py:42` | `RESTRICTED_SLOWDOWN = (5, 6)` from one measurement | Estimate only, labelled as such | Replace with measured timings once scans run (2) |
| H6 | `frontend/src/features/explore/Landing.tsx:92-98` | World forest "40.6 M km² · 31 %" (FAO FRA 2020) typed into JSX | Correct, cited, but a figure in code | Move to a cited reference-data file (0) |
| H7 | `frontend/src/lib/regions.ts:10-14` | Three explore regions (Amazon, Congo, Borneo) | Curated, fine | Keep |
| H8 | `backend/app/data/featured_investigations.json` + copies `frontend/public/data/featured.json`, `basemaps.json` | Curated featured areas; offline fallback copies | None: both copies are checked against the backend by tests (`backend/tests/test_coordinates.py:56`, `test_imagery.py:252`) | Keep |
| H9 | `backend/app/config.py:94` | Explainer model default `"claude-opus-5"` | Model ID must be checked against the current list; the explainer is unconfigured anyway | Verify or remove (0) |
| H10 | `analysis/config.toml` `[report]`, `[website]` | Author line, Noida thumbnail URL | Fine (config, by design) | Keep |

### 1.5 Prototype-only behaviour (works for one person on one machine)

| # | Where | What | Production problem | Fix (phase) |
|---|---|---|---|---|
| S1 | `backend/app/services/analysis.py:343` (`_jobs`, `_active`, `_rid_key`), `services/quickscan.py` (`_running`, `_failures`) | Job state in process memory | Lost on restart; wrong with >1 instance | Jobs table in Postgres (3) |
| S2 | `backend/app/ratelimit.py` | Per-process sliding window, keyed by IP | Per-instance; per-proxy without `--proxy-headers` (`docs/PRE_DEPLOYMENT.md` #3) | Postgres-backed per-USER limits (1, 3) |
| S3 | `backend/.cache/{aois,results,quickscan,context,tiles}`, `chat_counters.json` | All durable state as files on local disk | Ephemeral disks on most hosts; no backups | Durable records in Postgres; tiles stay a disposable cache (3) |
| S4 | `backend/app/providers/earth_engine/provider.py:364-393` | Earth Engine via `earthengine authenticate` user credentials | Not deployable to a server | Service account on a registered noncommercial project (3) |
| S5 | `backend/app/services/chat/` | Gemini free tier | Google may use content to improve products; EU/UK/CH need paid; 18+ only (`docs/PRE_DEPLOYMENT.md` #4–8) | Paid tier before public launch (7) |
| S6 | `backend/app/api/routes.py:372-379`, `config.py:148` | `/api/chat/stats` has no auth (off by default) | Admin data without admin auth | Admin-only route (1) |
| S7 | `backend/app/config.py:91` | `DEV_DIAGNOSTICS` adds internal facts to errors | Must never be on in production | Startup refusal in production mode (7) |
| S8 | No auth anywhere | Anyone can start Earth Engine work (rate-limited per IP only) | Quota abuse | Sign-in for quota-heavy actions + per-user daily limits (1–2) |

### 1.6 Leftovers and known defects

| # | Where | What | Fix (phase) |
|---|---|---|---|
| L1 | `frontend/archive/presentation/Presenter.tsx` | Archived, not built | Delete (0) |
| L2 | `backend/app/providers/reference/__init__.py` | Empty package (Hansen sampler removed) | Delete (0) |
| L3 | `frontend/src/lib/urlState.ts:15,101` | Strips a legacy `?mode=demo` parameter | Keep the strip, delete the comment's history (0) |
| L4 | `README.md:100` | Says method `tt-ee-2.1`; code is `tt-ee-2.4` | Update (0) |
| L5 | `docs/CURRENT_REPOSITORY_AUDIT.md` | Audit of 2026-09-27, before the clean-up | Mark historical (0) |
| L6 | `frontend/scripts/check-data-integrity.mjs:309` | Stops at the Hasdeo 2018→2025 step; clicks a live-analysis button (`docs/QUICKSCAN_PLAN.md` backlog 1) | Fix, never click live buttons (0) |
| L7 | Chat | Numeric "how much forest change" answer withheld although results exist (backlog 2) | Investigate + fix (0) |
| L8 | Branch `quickscan` | Quick scan complete offline, not merged; live run pending your approval | Merge in Phase 0 |
| L9 | No CI | Tests run only by hand | GitHub Actions (0) |

---

## 2. Architecture

### 2.1 Stack decision

**Recommended: Supabase + existing FastAPI + existing Vite SPA.**

- **Why Supabase fits this codebase.**
  - The data is relational: users, posts, answers, votes, tags, reports.
  - Row Level Security puts the "only edit your own" rules in one place, the database.
  - Auth gives Google and email sign-in without us storing passwords.
  - The free tier covers a launch.
- **Why the backend stays.**
  - Earth Engine work runs for minutes, with in-memory polling, a 234 MB dependency stack and a disk tile cache.
  - That cannot run as Vercel serverless functions (already established, `docs/` deployment notes).
- **Why not move to Next.js.**
  - The app is a client-heavy map application (MapLibre, Zustand) with a hash router. A Next.js rewrite would cost
    weeks for SEO the community does not need in v1.
  - We add a real path router instead (see 2.4).
- **Alternatives considered.**
  - Neon/Postgres plus our own auth: more code, no RLS out of the box.
  - Firebase: document store, a poor fit for votes, ranking and joins.
  - Clerk plus Postgres: good auth, but two vendors and no RLS integration.
- **Supabase free-tier caveats** (third-party summaries; check supabase.com/pricing before relying on them):
  - 500 MB database, 50k monthly active users.
  - A project **pauses after 7 days without database activity**.
  - No automatic backups.
  - Built-in email has a very low hourly limit and is not meant for production, so custom SMTP is needed.
  - For production we need a keep-alive plus backups, or the Pro plan.

**Who talks to Supabase:**

| Traffic | Path | Key used |
|---|---|---|
| Sign-in, session refresh | Browser → Supabase Auth | publishable key (`sb_publishable_…`, public by design) |
| Community **reads** (feed, threads, profiles, tags) | Browser → Supabase (PostgREST / SQL functions), RLS applies | publishable key + the user's session |
| Community **writes** (post, answer, comment, vote, report) | Browser → FastAPI → Supabase **with the user's own JWT** (so RLS still applies) | user JWT; spam/profanity/rate checks in FastAPI first |
| Saving analyses and scan snapshots, quota usage, reputation, moderation actions | FastAPI → Supabase | secret key (`sb_secret_…`), **backend only**, never a `VITE_` variable |

**Why community writes go through FastAPI:** profanity and spam filtering, link rules and rate limits need code, and
the user's JWT keeps RLS as the final guard. Analysis snapshots are written **only** by the backend, so a published
map and its stats are TerraTrace's own measurements and can never be forged by a client. That preserves the
"no simulated science" rule.

### 2.2 Authentication

- **Providers:** Google OAuth, plus email. **Decision for you (D1):** a passwordless magic link / one-time code
  (recommended: no passwords at all), or email + password (Supabase stores the hashes, we don't).
- **Frontend:** `@supabase/supabase-js` with the session in browser storage. A "Sign in" button and modal; the avatar
  menu becomes the account menu.
- **Backend JWT verification:**
  - **Keys:** verify against the project's JWKS at `https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json`
    (asymmetric ES256 signing keys; the legacy HS256 secret is not recommended).
  - **Library:** PyJWT `PyJWKClient`, caching keys for ~10 min, with a refetch on an unknown `kid`.
  - **Claims checked:** signature, `exp`, `aud = "authenticated"`, `iss = https://<ref>.supabase.co/auth/v1`, and
    `sub` as the user id.
  - **FastAPI dependencies:** `current_user_optional` and `current_user_required`.
- **Who may do what:**
  - **Logged out:** browse everything exactly as today, including stored featured results, the case study, reading
    the community, and the chat.
  - **Signed in:** run quick scans and (D2) new live forest analyses, save areas, publish, post, vote, report.
  - **D2:** require sign-in for new live forest analyses too? Recommended **yes** (they use the same Earth Engine
    quota). Stored results stay public.
- **Per-user daily limits** (protect the Earth Engine quota): e.g. 5 quick scans and 3 new analyses per user per day,
  plus a global daily cap. Stored in Postgres, so they survive restarts and multiple instances.
- **Admin role:** a `user_roles` table that only the backend (secret key) writes. You are inserted once by hand.

### 2.3 Database schema (Supabase Postgres)

Every table has RLS **enabled**. `auth.users` is Supabase's own table.

```sql
-- ---------------------------------------------------------------- people
create table profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  username      citext unique not null check (username ~ '^[a-z0-9_]{3,24}$'),
  display_name  text check (char_length(display_name) <= 60),
  bio           text check (char_length(bio) <= 500),
  avatar_url    text,
  reputation    integer not null default 0,          -- written only by triggers
  is_banned     boolean not null default false,      -- written only by admins
  created_at    timestamptz not null default now()
);
create table user_roles (                            -- written only with the secret key
  user_id uuid references profiles(id) on delete cascade,
  role    text check (role in ('admin','moderator')),
  primary key (user_id, role)
);

-- ---------------------------------------------------------------- saved work
create table areas (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references profiles(id) on delete cascade,
  name        text not null check (char_length(name) <= 80),
  geometry    jsonb not null,                        -- GeoJSON (PostGIS optional later, D4)
  bbox        double precision[4] not null,
  area_km2    double precision not null,
  backend_aoi_id text not null,                      -- the backend's registered AOI id
  created_at  timestamptz not null default now()
);
create type analysis_kind as enum ('forest', 'quick_scan');
create table analyses (                              -- inserted ONLY by the backend (secret key)
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references profiles(id) on delete cascade,
  area_id       uuid references areas(id) on delete set null,
  kind          analysis_kind not null,
  params        jsonb not null,                      -- window / year / season
  method_version text not null,                      -- tt-ee-2.4, qs-1-…
  summary       jsonb not null,                      -- frozen snapshot: KPIs, class areas, LST, carbon + sources
  map           jsonb not null,                      -- bbox + layer descriptors (tile paths on our backend)
  title         text check (char_length(title) <= 120),
  is_published  boolean not null default false,
  created_at    timestamptz not null default now()
);
create table usage_daily (                           -- per-user Earth Engine quota protection
  user_id  uuid references profiles(id) on delete cascade,
  day      date not null,
  quick_scans int not null default 0,
  analyses    int not null default 0,
  primary key (user_id, day)
);

-- ---------------------------------------------------------------- community
create type thread_target as enum ('general', 'case_study', 'analysis');
create type post_kind     as enum ('question', 'discussion', 'analysis_share');
create type content_state as enum ('visible', 'hidden', 'removed');
create table posts (
  id           uuid primary key default gen_random_uuid(),
  author_id    uuid not null references profiles(id) on delete cascade,
  kind         post_kind not null,
  target       thread_target not null default 'general',
  target_ref   text,                                 -- case-study slug ('noida-ghaziabad') or analyses.id
  analysis_id  uuid references analyses(id),         -- for analysis_share: snapshot copied by trigger
  title        text not null check (char_length(title) between 8 and 160),
  body         text not null check (char_length(body) <= 20000),   -- Markdown, sanitised on render
  score        integer not null default 0,           -- trigger-maintained
  hot          double precision not null default 0,  -- trigger-maintained ranking
  answer_count integer not null default 0,
  accepted_comment_id uuid,
  state        content_state not null default 'visible',
  search       tsvector generated always as
                 (setweight(to_tsvector('simple', title), 'A') || setweight(to_tsvector('simple', body), 'B')) stored,
  created_at   timestamptz not null default now(),
  edited_at    timestamptz
);
create index on posts using gin (search);
create index on posts (hot desc) where state = 'visible';
create index on posts (target, target_ref, created_at desc);
create table comments (                              -- top-level on a question = an answer; nested = a comment
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references posts(id) on delete cascade,
  parent_id  uuid references comments(id) on delete cascade,
  author_id  uuid not null references profiles(id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 10000),
  score      integer not null default 0,
  state      content_state not null default 'visible',
  created_at timestamptz not null default now(),
  edited_at  timestamptz
);
create table votes (
  user_id     uuid references profiles(id) on delete cascade,
  target_type text check (target_type in ('post','comment')),
  target_id   uuid not null,
  value       smallint not null check (value in (-1, 1)),
  created_at  timestamptz not null default now(),
  primary key (user_id, target_type, target_id)
);
create type tag_kind as enum ('region', 'topic', 'method');
create table tags (
  id    serial primary key,
  slug  text unique not null,                        -- 'india', 'amazon', 'uhi', 'lulc', 'deforestation', 'random-forest'
  name  text not null,
  kind  tag_kind not null
);
create table post_tags (post_id uuid references posts(id) on delete cascade, tag_id int references tags(id),
                        primary key (post_id, tag_id));
create table reports (
  id          uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references profiles(id) on delete cascade,
  target_type text check (target_type in ('post','comment','profile')),
  target_id   uuid not null,
  reason      text check (reason in ('spam','abuse','misinformation','off_topic','other')),
  note        text check (char_length(note) <= 500),
  status      text not null default 'open' check (status in ('open','actioned','dismissed')),
  handled_by  uuid references profiles(id), handled_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (reporter_id, target_type, target_id)
);
create table moderation_log (
  id bigserial primary key, moderator_id uuid references profiles(id), action text not null,
  target_type text not null, target_id uuid not null, reason text, created_at timestamptz not null default now()
);
create table reputation_events (                     -- audit trail; profiles.reputation = sum(delta)
  id bigserial primary key, user_id uuid references profiles(id) on delete cascade,
  delta int not null, reason text not null, source_type text, source_id uuid, created_at timestamptz default now()
);
```

**Triggers and functions (all `security definer`, owned by the database, with a fixed `search_path`):**

- `is_admin()` / `is_moderator()`: look up `user_roles` for `auth.uid()`.
- **`on_vote`:** keeps `score` and `hot` up to date and writes reputation events.
  - Reputation: +10 per post upvote, +5 per answer upvote, −2 per downvote received, +15 for an accepted answer.
  - You cannot vote on your own content.
  - `hot` uses the Reddit formula: `sign(score)·log10(max(|score|,1)) + epoch(created_at)/45000`.
- **`on_analysis_share`:** a post of kind `analysis_share` must reference an `analyses` row that the author owns and
  has published. The map and stats come from that row, never from the client.
- **`can_write()`:** not banned, account older than 10 minutes, and under the per-user limits (e.g. 10 posts per day,
  60 comments per day, 200 votes per day), counted in SQL so the rule is enforced inside the database.
- **`feed(sort, tags[], q, target, cursor)`:** one SQL function for Hot / New / Top (day, week, all) with search and
  tag filters, and keyset pagination.

### 2.4 Row Level Security policies (summary)

| Table | select | insert | update | delete |
|---|---|---|---|---|
| profiles | everyone | via trigger on sign-up | own row; only `username, display_name, bio, avatar_url` (column grants) | via account deletion |
| user_roles | own + admins | — (secret key only) | — | — |
| areas | own | own (`owner_id = auth.uid()`) | own | own |
| analyses | own, or `is_published` | — (backend, secret key) | own: only `title, is_published` | own |
| usage_daily | own | — (backend) | — (backend) | — |
| posts | `state = 'visible'`, or own, or moderators | `author_id = auth.uid() and can_write()` | own: `title, body` (sets `edited_at`); moderators: `state` | own → soft delete (`state = 'removed'`) |
| comments | same as posts | `author_id = auth.uid() and can_write()` and the post is visible | own: `body`; moderators: `state` | own → soft delete |
| votes | own | own, `can_write()`, not own content | own | own |
| tags, post_tags | everyone | admins (tags); post author (post_tags) | admins | admins / post author |
| reports | own + moderators | own (`reporter_id = auth.uid()`) | moderators | — |
| moderation_log | moderators | moderators (via functions) | — | — |
| reputation_events | own | — (triggers) | — | — |

Every policy gets a pgTAP test (`supabase test db`) covering own vs another user vs anonymous vs admin.

### 2.5 API routes (FastAPI, new)

| Method + path | Auth | What |
|---|---|---|
| `GET /api/me` | required | profile, roles, today's usage and limits |
| `POST /api/me/areas`, `DELETE /api/me/areas/{id}` | required | save an area (registers the backend AOI + inserts the row); remove it |
| `POST /api/me/analyses` | required | save a snapshot of a **stored** READY forest result or quick scan (backend reads its own result) |
| `PATCH /api/me/analyses/{id}` | required | title, publish / unpublish |
| `POST /api/quickscan/{aid}` (exists) | **required** (new) | + per-user daily limit |
| `POST /api/analysis-jobs` (exists) | **required** if D2 = yes | + per-user daily limit |
| `POST /api/community/posts`, `PATCH`/`DELETE /api/community/posts/{id}` | required | validate, profanity/spam filter, then insert/update with the user's JWT |
| `POST /api/community/posts/{id}/comments`, `PATCH`/`DELETE /api/community/comments/{id}` | required | same |
| `PUT /api/community/votes` | required | `{target_type, target_id, value: -1 \| 0 \| 1}` |
| `POST /api/community/posts/{id}/accept/{comment_id}` | required (post author) | accepted answer |
| `POST /api/community/reports` | required | report |
| `GET /api/admin/reports`, `POST /api/admin/moderate` | admin | queue; hide / remove / restore / ban, logged |
| `GET /api/chat/stats` (exists) | **admin** (new) | |

Reads (feed, thread, profile, tag lists, search) go **directly from the browser to Supabase** through the `feed()`
function and RLS-protected selects, so no backend route is needed.

### 2.6 Frontend pages

- **Router:** today the app uses hash routes (`#/analysis/…`, `#/case-study/…`, `lib/urlState.ts`).
  - **D3:** add path routes with `react-router` (recommended: shareable community URLs) and keep the old hash links
    working through a redirect, or stay on hash routes.
  - Vercel needs a SPA rewrite (`vercel.json`) for path routes.

| Page | Path (D3) | Content |
|---|---|---|
| Sign-in modal | — | Google, email (D1); terms + privacy consent; 18+ note (Gemini terms) |
| Dashboard | `/dashboard` | saved areas, past forest analyses and quick scans, usage today / limits, publish buttons |
| Community feed | `/community` | Hot / New / Top tabs, tag chips (region / topic / method), search, "Ask a question", "New post" |
| Post / thread | `/community/p/:id` | post, analysis card (map thumbnail + stats + sources) for shares, answers with votes and an accepted answer, nested comments, report |
| New post | `/community/new` | kind, title, Markdown body with preview, tags, optional "attach one of my published analyses" |
| Profile | `/u/:username` | reputation, posts, answers, published analyses |
| Case-study discussion | inside `/case-study/noida-ghaziabad` | "Discussion" section = posts with `target = case_study` |
| Analysis discussion | inside the analysis view | "Discussion" tab = posts with `target = analysis` |
| Admin | `/admin` | report queue, moderation actions, log |
| Legal | `/privacy`, `/terms`, `/content-policy` | short pages (what we store and why; rules; DPDP Act 2023 / GDPR basics: export and delete account) |

### 2.7 LULC, heatmap and carbon for every scanned area

- **Already built** as the quick scan (branch `quickscan`):
  - Dynamic World land-cover classes and areas.
  - A Landsat land-surface-temperature heatmap with per-class means and a simple UHI figure.
  - ESA CCI above-ground tree biomass carbon, with a range.
  - Map layers, legends, tier badges, chatbot rules, and 61 + 20 tests.
- **Still to do:**
  - Merge it into main (Phase 0).
  - Run the first live scan.
  - Require sign-in, with per-user limits (Phase 2).
  - Save scans to the dashboard and let users publish them (Phase 2 / 4).
- **Naming:** you asked for a "carbon index". It stays labelled **"above-ground tree biomass carbon (ESA CCI)"**, the
  decision of 2026-10-21. It is a measured density in t C/ha, not an index, and it excludes soil.

### 2.8 Chatbot and community

- Community posts are **never** chat facts: the validator only accepts the backend's own facts
  (`services/chat/facts.py`).
- A test will assert that no community table or text is ever read into the prompt.
- A published analysis may be quoted only through its frozen backend snapshot, tagged as its tier.

---

## 3. Production hardening checklist

**Security and secrets**
- [ ] Earth Engine: service account on the registered noncommercial project; key only in the host's secret store.
- [ ] Supabase **secret key**, Gemini key, Earth Engine key: backend env only; publishable key + URL as `VITE_`.
- [ ] Add a test that scans the frontend source and build for secrets (`sb_secret_`, `service_role`, `AIza`, private keys),
      like the existing imagery-URL scan (`backend/tests/test_imagery.py:265`).
- [ ] Disable the legacy anon/service_role keys once the new keys are in use.
- [ ] Turn on asymmetric JWT signing keys; verify with JWKS (2.2).
- [ ] Add a Content-Security-Policy header in `vercel.json`. Today it has nosniff, Referrer-Policy, X-Frame-Options
      and Permissions-Policy, but no CSP. Also check HSTS.
- [ ] Render Markdown with sanitisation (no raw HTML), `rel="nofollow ugc"` on links.
- [ ] CORS: exact origins (exists, `TT_CORS_ORIGINS`); request size caps (exist).
- [ ] Turnstile or hCaptcha on sign-up (Supabase Auth supports both).
- [ ] Refuse to start in production with `DEV_DIAGNOSTICS=true` or the chat stats route open.

**Abuse and limits**
- [ ] Per-user daily limits for quick scans and analyses, plus a global cap (Postgres).
- [ ] Community limits in `can_write()` + FastAPI. A profanity filter (English + Hindi/Hinglish word lists),
      a duplicate-post check, a link limit for new accounts, and "new account" restrictions.
- [ ] Rate limits behind the proxy: `--proxy-headers --forwarded-allow-ips` (`docs/PRE_DEPLOYMENT.md` #3); per-user,
      not per-IP, where signed in.
- [ ] Tile routes: a per-user or per-IP cap (`docs/PRE_DEPLOYMENT.md` #1).

**Reliability**
- [ ] Jobs, saved records and usage in Postgres; tile cache stays disposable.
- [ ] Backend host with enough disk and RAM, one worker process per instance, health checks.
- [ ] Database backups. The free tier has none, so add a nightly `pg_dump` via GitHub Actions to private storage,
      or use Pro.
- [ ] Supabase keep-alive so the free project never pauses.
- [ ] Earth Engine restricted mode stays visible to users (done for the quick scan).

**Errors, logging, monitoring**
- [ ] Public errors already never leak internals (`errors.py`); keep it.
- [ ] Structured JSON logs with request id and user id (never emails or tokens).
- [ ] Sentry (free tier) for frontend and backend.
- [ ] Uptime check on `/api/health`.

**Tests and CI**
- [ ] GitHub Actions: backend pytest, analysis pytest, frontend typecheck + build on every push.
- [ ] RLS tests (pgTAP) for every policy; API auth tests (anonymous, user, other user, admin).
- [ ] Fix the integrity script (L6) and add Playwright end-to-end tests (sign in, scan, publish, post, vote, report)
      against a test Supabase project.
- [ ] Frontend unit tests (Vitest) for ranking display, Markdown sanitising and auth state.

**Deployment**
- [ ] Vercel: frontend; env `VITE_API_BASE`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`; SPA rewrite.
- [ ] Backend: Google Cloud Run (same GCP project as Earth Engine, so service-account auth is simplest), or Render or
      Railway. Not Vercel.
- [ ] Database migrations in `supabase/migrations/` (Supabase CLI), applied by CI to a staging project first.
- [ ] Staging + production Supabase projects (free tier allows 2).

**Legal**
- [ ] Privacy policy (what we store: account email, profile, saved areas, posts, votes; why; retention; deletion).
- [ ] Terms of use and content policy.
- [ ] Gemini paid tier + 18+ + EU/UK handling (`docs/PRE_DEPLOYMENT.md` #4–6).
- [ ] Account deletion that removes personal data (cascade).

---

## 4. Phases

Estimates are working days and are approximate. Each phase ends with all tests green, a local commit, and your
review before the next one starts.

| Phase | Goal | Main files (new = ✚) | Days |
|---|---|---|---|
| **0. Foundations** | Merge `quickscan`; first live quick scan (with your OK); fix L1–L9, H1–H4, H6, H9; CI | `.github/workflows/ci.yml` ✚; `frontend/src/lib/time.ts`; `backend/app/services/science.py`, `config.py`, `imagery.py`, `context.py`; `frontend/scripts/check-data-integrity.mjs`; `services/chat/validator.py` or `facts.py`; `README.md`; delete `frontend/archive/`, `providers/reference/` | 3–4 |
| **1. Supabase + auth** | Sign-in (Google + email), profiles, roles, JWT verification, admin-only stats | `supabase/migrations/0001_profiles_roles.sql` ✚; `backend/app/auth.py` ✚; `config.py`; `api/routes.py`; `requirements.txt` (PyJWT[crypto]); `frontend/src/lib/supabase.ts` ✚; `features/auth/SignIn.tsx` ✚, `AccountMenu.tsx` ✚; `features/shell/Header.tsx`; `data/client.ts` (bearer token); tests `test_auth.py` ✚ | 3–4 |
| **2. Quotas, saved work, dashboard** | Sign-in for scans/analyses, per-user daily limits, save areas and analyses, dashboard | `0002_saved_work.sql` ✚; `backend/app/services/usage.py` ✚, `services/saved.py` ✚; `services/quickscan.py`, `services/analysis.py`, `api/routes.py`; `frontend/src/features/dashboard/*` ✚ (Dashboard, SavedAreas, SavedScans); router (D3) in `app/App.tsx`, `lib/urlState.ts`; tests ✚ | 4–5 |
| **3. Production backend** | Service-account Earth Engine; jobs and records in Postgres; deploy backend; Vercel env | `providers/earth_engine/provider.py` (init); `services/jobs.py` ✚; `services/analysis.py`, `quickscan.py`; `Dockerfile` ✚; `docs/DEPLOY.md` ✚; `vercel.json` | 3–4 |
| **4. Community core** | Posts, questions, answers, comments, votes, tags, threads on case studies and analyses, publish analysis | `0003_community.sql` ✚ (tables, triggers, RLS); `backend/app/services/community/{posts,moderation_filters}.py` ✚; `api/community.py` ✚; `frontend/src/features/community/*` ✚ (Feed, Post, NewPost, AnalysisCard, Thread, VoteButtons, TagPicker); `CaseStudyPage.tsx`, `AnalysisView.tsx` (Discussion); tests ✚ | 7–9 |
| **5. Ranking, search, profiles, reputation** | Hot / New / Top, full-text search, tags filter, profiles with reputation, accepted answers | `0004_feed_reputation.sql` ✚ (`feed()`, reputation triggers); `features/community/Profile.tsx` ✚, `Search.tsx` ✚; tests ✚ | 3–4 |
| **6. Moderation and policies** | Reports, admin queue, hide / remove / ban, profanity + spam rules, rate limits, legal pages | `0005_moderation.sql` ✚; `services/community/moderation.py` ✚; `api/admin.py` ✚; `features/admin/*` ✚; `features/legal/{Privacy,Terms,ContentPolicy}.tsx` ✚; word lists ✚; tests ✚ | 3–4 |
| **7. Hardening and launch** | CSP, Sentry, logs, backups, keep-alive, Gemini paid tier, E2E, load test, launch checklist | `vercel.json`; `backend/app/logging.py` ✚; `.github/workflows/{backup,e2e}.yml` ✚; `frontend/e2e/*` ✚; `docs/PRE_DEPLOYMENT.md` | 3–4 |
| | | **Total** | **≈ 29–38** |

---

## 5. What you set up yourself (Supabase and accounts)

1. **Create two Supabase projects,** `terratrace-staging` and `terratrace-prod`. Choose a region near your users,
   e.g. Mumbai (`ap-south-1`).
2. **Google sign-in.**
   - In Google Cloud Console, create an OAuth client ID (Web).
   - Add the authorised redirect URI `https://<project-ref>.supabase.co/auth/v1/callback`.
   - In Supabase → Authentication → Providers → Google, paste the client ID and secret.
3. **Email sign-in.**
   - Enable the Email provider (magic link or password, per D1).
   - Add **custom SMTP** (e.g. Resend or Brevo free tier); the built-in sender is not for production.
4. **URLs:** Authentication → URL configuration. Set the site URL (your Vercel domain), then add the redirect URLs
   `http://localhost:5173` and the Vercel preview pattern.
5. **API keys.**
   - Create a **publishable** key and a **secret** key.
   - Send me neither by chat: put them in the Vercel env (publishable) and the backend host's secrets (secret).
   - Later, disable the legacy keys.
6. **JWT signing keys:** turn on asymmetric signing keys (ES256).
7. **Captcha:** create a Cloudflare Turnstile site key and enable it under Authentication → Attack protection.
8. **Make yourself admin:** after your first sign-in, run one SQL line in the SQL editor (I'll give it to you).
9. **Earth Engine for the server:**
   - Create a service account in project `terratrace-509821` and register it for Earth Engine.
   - Store its key only in the backend host's secret manager.
10. **Gemini:** paid tier before a public launch (`docs/PRE_DEPLOYMENT.md`).

---

## 6. Risks

- **Earth Engine quota.** A public product multiplies runs. Per-user limits, sign-in and the restricted-mode notice
  help, but the Community tier (150 EECU-hours a month) will not carry real traffic. A Contributor (billing account)
  or Partner tier will be needed.
- **Supabase free tier.** Pausing after 7 idle days, no backups, and email limits. We need a keep-alive and backups
  or the Pro plan ($25/month).
- **Supabase changes.**
  - The new key types and JWT signing keys are recent.
  - Third-party summaries mention that new projects after 2026-05-30 need explicit Postgres grants for the Data API.
    Verify this on the docs when we create the migrations.
- **Moderation load.** You are the only admin. Spam usually arrives within days of a public sign-up; Turnstile, new
  account limits and the report queue are the minimum.
- **Scientific trust.** Published analyses must show their tier and method version and stay frozen snapshots, so a
  method change never silently alters a published post.
- **Legal.** Privacy and terms for a site with user content (India DPDP Act 2023; GDPR if EU users), and the Gemini
  terms (18+, paid tier for EU/UK).
- **Scope.** The community alone is ~3 weeks. The abstract deadline (2026-10-30) comes first; I suggest starting
  Phase 0 after it.

---

## 7. Decisions needed from you

| # | Question | Recommendation |
|---|---|---|
| D1 | Email sign-in: magic link / code, or password? | Magic link / code (no passwords) |
| D2 | Require sign-in for new live forest analyses too (not only quick scans)? | Yes; stored results stay public |
| D3 | Path routes with `react-router`, or keep hash routes? | Path routes, old links redirected |
| D4 | PostGIS for areas (spatial search "posts near here") now, or later? | Later (jsonb + bbox in v1) |
| D5 | Backend host: Google Cloud Run, Render or Railway? | Cloud Run (same GCP project as Earth Engine) |
| D6 | Daily limits per user (quick scans / analyses)? | 5 / 3 to start, global cap 100 / 30 |
| D7 | Start date | After the 2026-10-30 abstract |
