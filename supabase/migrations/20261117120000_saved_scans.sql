-- "My scans": a signed-in user's saved analyses (area + window + the headline figures shown when it was saved).
-- Private: only the owner can see, add, rename or delete their rows. The figures are a snapshot for the list; the app
-- always reopens the scan from the backend's stored result, so a saved row can never change what an analysis shows.

create table public.saved_scans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- A featured slug (e.g. rondonia-frontier) or a registered custom area (aoi-<12 hex>).
  aoi_id text not null check (aoi_id ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  baseline smallint not null check (baseline between 1984 and 2100),
  comparison smallint not null check (comparison between 1984 and 2100 and comparison > baseline),
  -- Headline figures at save time, e.g. {"status":"READY","net_change_ha":-123.4,...}. Small, flat JSON object.
  summary jsonb not null default '{}'::jsonb check (jsonb_typeof(summary) = 'object' and pg_column_size(summary) <= 8192),
  -- [west, south, east, north] in degrees, for the map thumbnail and community posts.
  bbox double precision[] check (bbox is null or (array_length(bbox, 1) = 4 and bbox[1] between -180 and 180 and bbox[3] between -180 and 180
                                                   and bbox[2] between -90 and 90 and bbox[4] between -90 and 90)),
  created_at timestamptz not null default now(),
  unique (user_id, aoi_id, baseline, comparison)
);

comment on table public.saved_scans is 'TERRATRACE "My scans" (one row per user, area and window). RLS: owner only.';
create index saved_scans_user_created on public.saved_scans (user_id, created_at desc);

alter table public.saved_scans enable row level security;

create policy "saved_scans: owner can read" on public.saved_scans for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "saved_scans: owner can insert" on public.saved_scans for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "saved_scans: owner can update" on public.saved_scans for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "saved_scans: owner can delete" on public.saved_scans for delete to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.saved_scans from anon, authenticated;
grant select, insert, delete on public.saved_scans to authenticated;
grant update (name, summary) on public.saved_scans to authenticated;
