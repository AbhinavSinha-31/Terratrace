# Accounts: Supabase setup

Sign-in (Google and email) and user profiles are handled by Supabase. Sign-in is optional: exploring and analysing
areas keeps working without an account. When the frontend has no Supabase settings, the app shows "Accounts are not
available yet" and makes no Supabase requests.

The browser holds only the project URL and the **publishable** key. Both are public by design, because Row Level
Security protects the data. The secret / `service_role` key bypasses Row Level Security. It never goes in the
frontend, in any `VITE_` variable or in Git, and nothing here needs it.

## 1. Create the project

[supabase.com/dashboard](https://supabase.com/dashboard) → New project. Note the project ref (`https://<ref>.supabase.co`).

## 2. Apply the migrations

Run every file in `supabase/migrations/` in name order. Use one of these two ways:

- **Dashboard:** SQL Editor → paste the file → Run.
- **CLI:** `npx supabase login`, then `npx supabase link --project-ref <ref>`, then `npx supabase db push`
  (run from the repository root).

Check: Table Editor → `profiles` shows "RLS enabled", with two policies (owner can read, owner can update).

## 3. Redirect URLs

Authentication → URL Configuration:

- **Site URL:** the production frontend, e.g. `https://<project>.vercel.app/`
- **Redirect URLs:** add each origin the app runs on, with the trailing slash:
  `http://localhost:5173/`, `http://127.0.0.1:5173/`, `https://<project>.vercel.app/`

The app sends users back to its own root (`origin + path`, no `#/…`). Supabase adds `?code=…`, and the app removes it
after signing in.

## 4. Google sign-in

1. [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → OAuth consent screen. Set it up as
   External and add the app name and support email.
2. Credentials → Create credentials → OAuth client ID → **Web application**.
   - Authorized JavaScript origins: the same origins as in step 3 (without the trailing slash).
   - Authorized redirect URI: `https://<ref>.supabase.co/auth/v1/callback`
3. Copy the client ID and client secret into Supabase → Authentication → Providers → Google → Enable.
   The client secret lives only in Supabase.

## 5. Email sign-in

Authentication → Providers → Email is on by default. Keep **Confirm email** on: a new account must open the
confirmation link, in the same browser, before it can sign in. Supabase's built-in mail server has a very low hourly
send limit and is meant for testing. Before real users sign up, set up custom SMTP under Authentication → Emails.
Password reset uses the same redirect URLs.

## 6. Frontend settings

Project Settings → API Keys → copy the **publishable** key (`sb_publishable_…`; the legacy `anon` key also works).

```powershell
cd frontend
copy .env.example .env     # then set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY
npm run dev
```

On Vercel, set the same two variables under Project → Settings → Environment Variables, then redeploy. Vite bakes
them into the bundle at build time.

## Tests

```powershell
cd supabase; npm install; npm test; cd ..     # migrations + Row Level Security on an in-memory Postgres (no Docker)
```

The browser check answers every Supabase request itself, so it needs no project and no account. Build once with any
Supabase values and serve the build:

```powershell
cd frontend
$env:VITE_SUPABASE_URL="https://tt-auth-test.supabase.co"; $env:VITE_SUPABASE_PUBLISHABLE_KEY="sb_publishable_test"
npx vite build --outDir ..\..\tt-auth-build; Remove-Item Env:VITE_SUPABASE_URL, Env:VITE_SUPABASE_PUBLISHABLE_KEY
npx vite preview --outDir ..\..\tt-auth-build --port 5174       # leave running; in a second terminal:
$env:TT_URL="http://127.0.0.1:5174/"; npm run test:auth
```

## What exists so far

| Table | Who can read | Who can write | Created by |
| --- | --- | --- | --- |
| `profiles` (`display_name`, `avatar_url`) | the owner | the owner: `display_name` and `avatar_url` only | a trigger on sign-up; deleted with the user |
