# Deploying TERRATRACE

| Part | Runs on | Config in the repo |
|---|---|---|
| Frontend (React + Vite, static) | **Vercel**, project Root Directory = `frontend` | `frontend/vercel.json`, `frontend/.vercelignore` |
| Backend (FastAPI + Google Earth Engine) | **Render**, one web service, root directory `backend` | `render.yaml` (Blueprint) |
| Accounts, saved scans, community, avatars | **Supabase** (Auth, Postgres with Row Level Security, Storage) | `supabase/migrations/` |

Before going public, also read [docs/PRE_DEPLOYMENT.md](docs/PRE_DEPLOYMENT.md) (Gemini terms: free-tier review, EEA/UK/CH, 18+).

## Why the backend is a long-running service (not serverless)

An analysis is a background job polled by the browser and kept in the process's memory; a quick scan can take up to
15 minutes in Earth Engine restricted mode; results and map tiles are a file cache; rate limits are per process. So the
backend runs as **one instance with one worker**. It is set up for Render's **free plan** (no disk, sleeps when idle);
see [Switching to Starter + disk](#switching-to-starter--disk-later) to keep results across restarts.

## 0. Once

1. **Push to GitHub** (the local repository has no remote yet):
   `git remote add origin https://github.com/<you>/terratrace.git` then `git push -u origin main`.
2. **Earth Engine service account** (a server cannot use your personal `earthengine authenticate` login):
   Google Cloud Console → project `terratrace-509821` → IAM & Admin → Service Accounts → Create (e.g. `terratrace-backend`)
   → roles **Earth Engine Resource Viewer** + **Service Usage Consumer** → Keys → Add key → JSON. Keep the file outside
   the repository (it is git-ignored by name patterns, but never copy it into the repo).
3. **Supabase**: run every file in `supabase/migrations/` in order in the SQL Editor (they are safe to re-run where noted).

## 1. Backend on Render

1. Render → **New → Blueprint** → select the repository. Render reads `render.yaml` and creates `terratrace-api`
   (Python, root directory `backend`, **Free** plan, no disk, health check `/api/health/live`).
2. **Environment → Secret Files → Add**: filename `ee-service-account.json`, contents = the JSON key. Render mounts it
   at `/etc/secrets/ee-service-account.json`, which `EE_SERVICE_ACCOUNT_KEY` points to.
3. Fill in the variables Render asks for (`sync: false`), deploy, then open `https://<service>.onrender.com/api/health`
   → `"analysis": {"status": "ready"}`.

**Build command:** `pip install -r requirements.txt`
**Start command:** `uvicorn app.main:app --host 0.0.0.0 --port $PORT --workers 1 --proxy-headers --forwarded-allow-ips="*"`
(equivalent: `python -m app`, which also reads `$PORT`).

### Render environment variables

| Name | What it is |
|---|---|
| `PYTHON_VERSION` | Python used for the build (`3.14.0`, set by `render.yaml`). |
| `EE_PROJECT` | Google Cloud project registered for Earth Engine (`terratrace-509821`). |
| `EE_SERVICE_ACCOUNT_KEY` | Path of the service-account JSON key — the Secret File `/etc/secrets/ee-service-account.json`. |
| `ALLOWED_ORIGINS` | Exact frontend origins allowed by CORS, comma-separated (the Vercel URL, a custom domain); no wildcards. |
| `TT_CACHE_DIR` | Where stored results, quick scans and tiles are kept. Free plan: `/tmp/terratrace-cache` (ephemeral, created at start). |
| `TT_TILE_CACHE_MB` | Map-tile cache budget in MB — `256` on the free plan's small ephemeral disk. |
| `SUPABASE_URL` | Supabase project URL; the backend verifies users' sign-in tokens with the project's public keys. |
| `GEMINI_API_KEY` | Google Gemini API key for Ask TerraTrace (secret; backend only). |
| `TT_CHAT_ENABLED` | `true` to switch Ask TerraTrace on. |
| `TT_LLM_TIER` | `free` or `paid` — which Gemini tier the key belongs to. |
| `DEV_DIAGNOSTICS` | Must stay `false` in production. |
| `TT_LLM_MODEL` | Optional: Gemini model override (e.g. when the default model is overloaded). |
| `ANTHROPIC_API_KEY` | Optional: AI-written analysis briefings (otherwise a deterministic briefing is used). |

`PORT` is set by Render itself.

### What the free plan means

- **Sleeps** after about 15 minutes without requests and takes about a minute to wake. The site's nav badge shows
  "Waking up…" meanwhile, and turns grey ("Analysis offline") only if the backend still has not answered after its retries.
  An open tab checks every 60 s (paused while the tab is hidden), which keeps the backend awake while someone is using it.
- **The cache is empty on every start** (deploy, restart or wake): `TT_CACHE_DIR` is created then. Nothing breaks:
  stored-result endpoints answer "not run yet", and the featured investigations are re-computed on Earth Engine in the
  background, one at a time, after each start (`TT_PRECOMPUTE_FEATURED`, on by default). Until each finishes its card
  shows that it has not been run. Set `TT_PRECOMPUTE_FEATURED=false` to save Earth Engine quota; featured results then
  appear only when a visitor runs them.
- **Running analyses are lost** if the service sleeps or restarts mid-run; the browser shows the analysis as failed and
  it can be run again.

### Switching to Starter + disk later

To keep stored results, quick scans and tiles across restarts and stop the sleeping:

1. In `render.yaml`, change `plan: free` to `plan: starter` and add under the service (same indent as `envVars`):
   ```yaml
       disk:
         name: terratrace-cache
         mountPath: /var/data
         sizeGB: 5
   ```
2. Set `TT_CACHE_DIR` to `/var/data/cache` and remove `TT_TILE_CACHE_MB` (the default, 1024 MB, fits the disk).
3. Commit and push; Render applies the Blueprint change (or do the same in the dashboard: Settings → Instance Type,
   Disks → Add Disk, Environment). A disk needs a paid instance and allows only one instance, which TERRATRACE needs anyway.
   The first start after the switch begins with an empty disk; results are computed and kept from then on.

## 2. Frontend on Vercel

1. Vercel → **Add New Project** → import the repository → **Root Directory: `frontend`** (Vercel then uses
   `frontend/vercel.json`: `npm ci`, `npm run build`, output `dist`).
2. Settings → Environment Variables (Production, and Preview if used), then deploy. Every `VITE_` variable is baked into
   the public bundle at build time: redeploy after changing one, and never put a secret in it.

### Vercel environment variables

| Name | What it is |
|---|---|
| `VITE_API_URL` | The backend's public origin on Render, e.g. `https://terratrace-api.onrender.com` (`/api` is appended). |
| `VITE_SUPABASE_URL` | Supabase project URL, `https://kmjranrbtlxbsvrtpxpl.supabase.co`. |
| `VITE_SUPABASE_ANON_KEY` | Supabase publishable (anon) key — public by design; never the secret / service_role key. |
| `VITE_SITE_URL` | The site's public URL (e.g. `https://terratrace.vercel.app`) — makes the link-preview image URL absolute. |
| `VITE_AUTH_GOOGLE` | `true` only after Google sign-in is set up in Supabase (section 4); otherwise leave unset. |

3. Add the Vercel URL to Render's `ALLOWED_ORIGINS` and to Supabase (section 3).

## 3. Supabase

1. **SQL Editor**, in order: `20261025120000_profiles.sql`, `20261117120000_saved_scans.sql`,
   `20261117130000_community.sql`, `20261118090000_repair_data_api.sql` (also reloads the API schema cache and shows a
   check table), `20261120090000_avatars_storage.sql` (profile-photo bucket).
2. **Authentication → URL Configuration**: Site URL = the Vercel URL; Redirect URLs: `http://localhost:5173/**` and
   `https://<your-project>.vercel.app/**` (plus a custom domain if any).
3. **Authentication → Emails → SMTP**: set up custom SMTP before real users sign up (the built-in mailer only delivers
   to your own team and is rate-limited).

## 4. Google sign-in (optional)

Google Cloud → OAuth consent screen + OAuth client (Web): JavaScript origins = the Vercel URL and
`http://localhost:5173`; redirect URI = `https://kmjranrbtlxbsvrtpxpl.supabase.co/auth/v1/callback`. Supabase →
Authentication → Providers → Google: paste the client ID and secret. Then `VITE_AUTH_GOOGLE=true` on Vercel.

## 5. After deploying — check

- `https://<backend>/api/health` → 200 with `analysis.status = ready`; `/api/me` without a token → 401.
- The Vercel site's nav badge turns green ("Live analysis online"; "Waking up…" for up to a minute while a sleeping backend starts), Community lists the seed posts, Ask TerraTrace answers.
- Browser dev tools → Network: no request carries a Gemini or Earth Engine key; Supabase requests carry only the anon
  key and the user's own token.

## Local development

```powershell
# backend/.env:         EE_PROJECT, SUPABASE_URL, GEMINI_API_KEY, TT_CHAT_ENABLED   (git-ignored)
# frontend/.env.local:  VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY                   (git-ignored)
.\run-dev.ps1            # backend 127.0.0.1:8001 (new window) + Vite http://localhost:5173 (proxies /api)
```
