# Deploying TERRATRACE

Three services, each with its own secrets:

| Part | Runs on | Why |
|---|---|---|
| Frontend (React + Vite, static) | **Vercel** (`vercel.json` at the repo root) | Static files + a CDN; nothing secret in it. |
| Backend (FastAPI + Earth Engine) | **Railway**, from the repo-root `Dockerfile` | See "Why not Vercel functions" below. |
| Accounts, saved scans, community | **Supabase** (Auth + Postgres with Row Level Security) | The browser talks to Supabase directly with the public anon key; RLS protects the data. |

Before going public, also work through [docs/PRE_DEPLOYMENT.md](docs/PRE_DEPLOYMENT.md) (Gemini terms: 18+, free-tier review, EEA/UK/CH).

## Why the backend is not on Vercel functions

Measured on this project, not assumed:

- An analysis is a **background job** polled by the browser (`/api/analysis-jobs/{id}`) and kept in the process's memory;
  in Earth Engine restricted mode a quick scan may take up to 15 min (`TT_QUICKSCAN_RESTRICTED_DEADLINE_S=900`).
  Serverless functions end with the response and do not share memory between invocations.
- Results, quick scans, tiles and registered areas are a **file cache** (`TT_CACHE_DIR`) that must survive restarts.
- Rate limits and the "one Earth Engine request at a time" queue are **per process**.
- Dependencies (earthengine-api, google-genai, Pillow, …) exceed what a function bundle should carry.

So the backend runs as **one always-on container with one worker and a persistent volume**. Railway gives exactly
that from the existing `Dockerfile`. (Render with a paid instance + disk also works; Cloud Run would need
`--no-cpu-throttling`, min/max instances = 1 and a mounted bucket — more moving parts.)

## 0. Prerequisites (once)

1. **Push the repository to GitHub.** It has no remote yet: create an empty private repo, then
   `git remote add origin https://github.com/<you>/terratrace.git && git push -u origin feat/complete`
   (or merge into `main` first). Vercel and Railway deploy from GitHub.
2. **Earth Engine service account** (the server cannot use your personal `earthengine authenticate` login):
   1. Google Cloud Console → project **terratrace-509821** → IAM & Admin → Service Accounts → *Create service account*
      (e.g. `terratrace-backend`).
   2. Grant it **Earth Engine Resource Viewer** and **Service Usage Consumer**.
   3. *Keys* → *Add key* → JSON → download. Keep the file outside the repo; it is the only copy.
3. **Supabase**: the three files in `supabase/migrations/` applied in order (SQL Editor), and Auth set up (section 3).

## 1. Backend on Railway

1. Railway → *New project* → *Deploy from GitHub repo* → this repo. Railway finds the root `Dockerfile`.
2. *Settings* → **Volumes** → *Add volume*, mount path **`/data`** (the image's `TT_CACHE_DIR`).
3. *Settings* → *Deploy*: **Replicas = 1** (jobs and limits live in memory), healthcheck path **`/api/health/live`**.
4. *Settings* → *Networking* → *Generate domain*, e.g. `https://terratrace-api.up.railway.app`.
5. *Variables*:

| Variable | Value | Required |
|---|---|---|
| `EE_PROJECT` | `terratrace-509821` | yes |
| `EE_SERVICE_ACCOUNT_JSON` | the **whole content** of the service-account JSON key (paste it; Railway stores it encrypted) | yes |
| `TT_CORS_ORIGINS` | `https://<your-project>.vercel.app` — exact origins, comma-separated, no wildcard; add a custom domain here too | yes |
| `SUPABASE_URL` | `https://kmjranrbtlxbsvrtpxpl.supabase.co` (verifies users' tokens through the project's public JWKS, ES256) | yes for `/api/me` |
| `GEMINI_API_KEY` | your Gemini API key (backend only — never a `VITE_` variable) | for the chat |
| `TT_CHAT_ENABLED` | `true` to switch the chat on (read docs/PRE_DEPLOYMENT.md items 4–7 first) | for the chat |
| `TT_LLM_TIER` | `free` (default) or `paid` — changes the notice next to the chat | optional |
| `TT_LLM_MODEL` | e.g. `gemini-3.5-flash-lite` if the default model is overloaded | optional |
| `ANTHROPIC_API_KEY` | optional AI briefing; without it a deterministic briefing is used | optional |
| `DEV_DIAGNOSTICS` | `false` (must stay false in production) | — |

Not needed: `PORT` (Railway sets it), `TT_CACHE_DIR` (`/data` in the image), `SUPABASE_JWT_SECRET` (only for legacy
HS256 projects). **Never** set a Supabase `service_role` / `sb_secret_` key anywhere — nothing uses it.

6. Deploy, then check `https://<backend>/api/health` → `"analysis": {"status": "ready"}`. The first start pre-computes
   the featured investigations one at a time (several minutes in restricted mode); the site works meanwhile.

## 2. Frontend on Vercel

1. Vercel → *Add New Project* → import the repo. Keep the **root directory = repository root**: `vercel.json` installs
   and builds `frontend/` and publishes `frontend/dist`. `.vercelignore` keeps the backend, `analysis/`, `supabase/`,
   docs and every secret pattern out of the upload.
2. *Settings* → *Environment Variables* (Production, and Preview if you use previews):

| Variable | Value |
|---|---|
| `VITE_API_URL` | the Railway origin, e.g. `https://terratrace-api.up.railway.app` (`/api` is appended). `VITE_API_BASE=https://…/api` also works. |
| `VITE_SUPABASE_URL` | `https://kmjranrbtlxbsvrtpxpl.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | the **publishable / anon** key (`sb_publishable_…`). Public by design; RLS protects the data. |
| `VITE_AUTH_GOOGLE` | `true` only after section 4 is done; otherwise leave unset |

Every `VITE_` variable is **baked into the public bundle** at build time: redeploy after changing one, and never put a
secret there.
3. Deploy. Add the Vercel URL to the backend's `TT_CORS_ORIGINS` (section 1) and to Supabase (section 3).

## 3. Supabase: migrations and redirect URLs

1. **SQL Editor** → run, in order: `supabase/migrations/20261025120000_profiles.sql`, `…20261117120000_saved_scans.sql`,
   `…20261117130000_community.sql`. Then run `notify pgrst, 'reload schema';` so the Data API sees the new tables.
   Check: `https://kmjranrbtlxbsvrtpxpl.supabase.co/rest/v1/post_feed?select=title` with the anon key returns the three
   seed posts (or open the app's Community page).
2. **Authentication → URL Configuration**:
   - **Site URL**: the production frontend, e.g. `https://<your-project>.vercel.app` (emails fall back to it).
   - **Redirect URLs** (*Add URL* for each):
     - `http://localhost:5173/**` (development)
     - `https://<your-project>.vercel.app/**` (production)
     - `https://<your-project>-*-<your-team>.vercel.app/**` (Vercel preview deployments, optional)
     - your custom domain `https://example.org/**`, if any
   The app sends users back to `origin + path` (PKCE); any URL not listed here is replaced by the Site URL.
3. **Authentication → Sign In / Providers → Email**: keep *Confirm email* on for production. Supabase's built-in mailer
   only delivers to your project's team members and is rate-limited — set up custom SMTP (*Authentication → Emails →
   SMTP settings*) before real users sign up, or sign-up confirmations and magic links will not arrive.

## 4. Google sign-in (optional)

1. Google Cloud Console → *APIs & Services* → *OAuth consent screen*: External, app name TERRATRACE, your support email,
   scopes `email`, `profile`, `openid`; add test users while in *Testing*.
2. *Credentials* → *Create credentials* → *OAuth client ID* → **Web application**:
   - Authorized JavaScript origins: `https://<your-project>.vercel.app`, `http://localhost:5173`
   - Authorized redirect URI: **`https://kmjranrbtlxbsvrtpxpl.supabase.co/auth/v1/callback`**
3. Supabase → *Authentication → Sign In / Providers → Google*: enable, paste the client ID and client secret, save.
4. Vercel: `VITE_AUTH_GOOGLE=true`, redeploy. (Locally: same line in `frontend/.env.local`, restart Vite.)

## 5. After deploying — verify

- `GET https://<backend>/api/health` → 200, `analysis.status = ready`, `chat.status` as configured.
- Open the Vercel URL: header says *Live*, featured cards load, a featured analysis opens with its stored result.
- Community → the three seed posts are listed; sign up (email arrives), sign in, save a scan, post, comment, vote,
  sign out, reload as a guest and read.
- Browser dev tools → Network: no request carries a Gemini or Earth Engine key; Supabase requests carry only the anon
  key and the user's own access token.
- `GET https://<backend>/api/me` without a token → 401 (with a valid user token → 200 `{id, email}`).

## Local development (reference)

```powershell
# backend/.env:            EE_PROJECT, SUPABASE_URL, GEMINI_API_KEY, TT_CHAT_ENABLED   (git-ignored)
# frontend/.env.local:     VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY [, VITE_AUTH_GOOGLE] (git-ignored)
.\run-dev.ps1              # backend 127.0.0.1:8001 (new window) + Vite http://localhost:5173
```
