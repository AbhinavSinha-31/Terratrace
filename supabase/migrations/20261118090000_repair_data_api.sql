-- Repair: make the Data API (PostgREST) see the TERRATRACE tables. Safe to run any number of times.
--
-- Symptom (2026-11-18, project kmjranrbtlxbsvrtpxpl): every table — even plain public.profiles — answered
--   404 PGRST205 "Could not find the table 'public.<name>' in the schema cache"
-- while the `public` schema IS exposed (PGRST106 lists "public, graphql_public"). Not RLS (that returns 200 []), not
-- grants (42501), not a bad join (PGRST200). So either the tables do not exist in THIS database, or the API's schema
-- cache was never reloaded after they were created. This file tells the two apart and fixes the second.

-- 1. The tables must exist here. If not, stop with the list (the earlier migrations ran in another project / failed).
do $$
declare
  missing text;
begin
  select string_agg(t, ', ') into missing
  from unnest(array['profiles', 'saved_scans', 'posts', 'comments', 'votes', 'post_feed']) as t
  where to_regclass('public.' || t) is null;
  if missing is not null then
    raise exception 'TERRATRACE: missing in this database: %. Run supabase/migrations/20261025120000_profiles.sql, '
      '20261117120000_saved_scans.sql and 20261117130000_community.sql in THIS project (check the project ref in the '
      'dashboard URL), then run this file again.', missing;
  end if;
end $$;

-- 2. Re-state the API grants (identical to the migrations; a no-op when they are already in place). Covers projects
--    whose "expose new tables" setting withheld privileges from the API roles.
grant usage on schema public to anon, authenticated;

grant select on public.profiles to anon, authenticated;
grant update (display_name, avatar_url) on public.profiles to authenticated;

grant select, insert, delete on public.saved_scans to authenticated;
grant update (name, summary) on public.saved_scans to authenticated;

grant select on public.posts, public.comments, public.post_feed to anon, authenticated;
grant insert (title, body, tags, scan_id, aoi_id, baseline, comparison, region, bbox) on public.posts to authenticated;
grant update (title, body, tags, region) on public.posts to authenticated;
grant delete on public.posts to authenticated;
grant insert (post_id, parent_id, body) on public.comments to authenticated;
grant update (body, deleted) on public.comments to authenticated;
grant delete on public.comments to authenticated;

grant select, delete on public.votes to authenticated;
grant insert (post_id, comment_id, value) on public.votes to authenticated;
grant update (value) on public.votes to authenticated;

-- 3. Tell the Data API to re-read the schema (the actual fix when the tables exist but the cache is stale).
notify pgrst, 'reload schema';

-- 4. What the API roles can see now (the SQL Editor shows this table): every row should be true / true.
select t as table_name,
       has_table_privilege('anon', 'public.' || t, 'select') as anon_can_read,
       (select count(*) from public.posts) as posts_in_database
from unnest(array['profiles', 'posts', 'comments', 'post_feed']) as t;
