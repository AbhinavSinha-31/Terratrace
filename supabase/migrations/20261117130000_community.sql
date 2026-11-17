-- Community: discussion posts around research reports and analyses, threaded comments, and votes.
-- Everyone (including signed-out visitors) can read; signed-in users can post, comment and vote; authors can edit and
-- delete their own posts and comments. Scores and comment counts are kept by triggers — clients can never write them.

-- ---------------------------------------------------------------------------------------------------------- profiles
-- Author names and photos appear next to posts, so profiles become publicly readable. They hold no email or other
-- private data (id, display_name, avatar_url, timestamps). Editing stays owner-only (20261025120000_profiles.sql).
drop policy "profiles: owner can read" on public.profiles;
create policy "profiles: anyone can read" on public.profiles for select to anon, authenticated using (true);
grant select on public.profiles to anon;
comment on table public.profiles is 'TERRATRACE user profile (one per auth.users row). Public read; owner update.';

-- ------------------------------------------------------------------------------------------------------------- posts
create table public.posts (
  id uuid primary key default gen_random_uuid(),
  -- null only for posts seeded by TERRATRACE itself (shown as "TERRATRACE"); users always post as themselves.
  author_id uuid default auth.uid() references public.profiles (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 3 and 200),
  body text not null check (char_length(btrim(body)) between 1 and 20000),       -- markdown, rendered without raw HTML
  tags text[] not null default '{}' check (cardinality(tags) <= 6 and array_to_string(tags, ',') ~ '^([a-z0-9][a-z0-9-]{0,31}(,|$))*$'),
  -- Optional link to an analysis: the post page reads the MEASURED result from the TERRATRACE backend with these.
  scan_id uuid references public.saved_scans (id) on delete set null,
  aoi_id text check (aoi_id ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  baseline smallint check (baseline between 1984 and 2100),
  comparison smallint check (comparison between 1984 and 2100),
  region text check (char_length(region) <= 120),
  bbox double precision[] check (bbox is null or (array_length(bbox, 1) = 4 and bbox[1] between -180 and 180 and bbox[3] between -180 and 180
                                                   and bbox[2] between -90 and 90 and bbox[4] between -90 and 90)),
  score integer not null default 0,
  comment_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search tsvector generated always as (to_tsvector('english', title || ' ' || coalesce(region, '') || ' ' || body)) stored,
  check ((baseline is null) = (comparison is null) and (baseline is null or comparison > baseline)),
  check (aoi_id is not null or baseline is null)
);
comment on table public.posts is 'Community posts. RLS: public read, signed-in insert as self, author update/delete.';
create index posts_created on public.posts (created_at desc);
create index posts_score on public.posts (score desc, created_at desc);
create index posts_tags on public.posts using gin (tags);
create index posts_search on public.posts using gin (search);
create index posts_aoi on public.posts (aoi_id) where aoi_id is not null;

alter table public.posts enable row level security;
create policy "posts: anyone can read" on public.posts for select to anon, authenticated using (true);
-- A post may link only the author's OWN saved scan (saved_scans RLS hides everyone else's rows from this subquery).
create policy "posts: signed-in users post as themselves" on public.posts for insert to authenticated
  with check ((select auth.uid()) = author_id
              and (scan_id is null or exists (select 1 from public.saved_scans s where s.id = scan_id)));
create policy "posts: author can update" on public.posts for update to authenticated
  using ((select auth.uid()) = author_id) with check ((select auth.uid()) = author_id);
create policy "posts: author can delete" on public.posts for delete to authenticated
  using ((select auth.uid()) = author_id);

revoke all on public.posts from anon, authenticated;
grant select on public.posts to anon, authenticated;
grant insert (title, body, tags, scan_id, aoi_id, baseline, comparison, region, bbox) on public.posts to authenticated;
grant update (title, body, tags, region) on public.posts to authenticated;
grant delete on public.posts to authenticated;

create trigger posts_set_updated_at before update on public.posts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------------------- comments
create table public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  parent_id uuid references public.comments (id) on delete cascade,
  author_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 10000),
  -- "Delete" in the app keeps the reply tree: the body is replaced and the author hidden (see comments_soft_delete).
  deleted boolean not null default false,
  score integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.comments is 'Threaded comments (parent_id). RLS: public read, signed-in insert as self, author update/delete.';
create index comments_post on public.comments (post_id, created_at);
create index comments_parent on public.comments (parent_id);

alter table public.comments enable row level security;
create policy "comments: anyone can read" on public.comments for select to anon, authenticated using (true);
create policy "comments: signed-in users comment as themselves" on public.comments for insert to authenticated
  with check ((select auth.uid()) = author_id);
create policy "comments: author can update" on public.comments for update to authenticated
  using ((select auth.uid()) = author_id) with check ((select auth.uid()) = author_id);
create policy "comments: author can delete" on public.comments for delete to authenticated
  using ((select auth.uid()) = author_id);

revoke all on public.comments from anon, authenticated;
grant select on public.comments to anon, authenticated;
grant insert (post_id, parent_id, body) on public.comments to authenticated;
grant update (body, deleted) on public.comments to authenticated;
grant delete on public.comments to authenticated;

create trigger comments_set_updated_at before update on public.comments
  for each row execute function public.set_updated_at();

-- A reply must belong to the same post as its parent; a deleted comment cannot be revived or edited.
create function public.comments_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.parent_id is not null and not exists (select 1 from public.comments p where p.id = new.parent_id and p.post_id = new.post_id) then
    raise exception 'parent comment belongs to another post' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' then
    if old.deleted then
      raise exception 'deleted comments cannot be changed' using errcode = '42501';
    end if;
    if new.deleted then
      new.body := '[deleted]';
    end if;
  end if;
  return new;
end;
$$;
create trigger comments_guard before insert or update on public.comments
  for each row execute function public.comments_guard();

-- comment_count on posts (security definer: commenters cannot update other people's posts).
create function public.comments_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    update public.posts set comment_count = comment_count + 1 where id = new.post_id;
  elsif tg_op = 'DELETE' then
    update public.posts set comment_count = greatest(comment_count - 1, 0) where id = old.post_id;
  end if;
  return null;
end;
$$;
create trigger comments_count after insert or delete on public.comments
  for each row execute function public.comments_count();

-- ------------------------------------------------------------------------------------------------------------- votes
-- One vote (+1 / -1) per user per post or comment. Changing a vote = update; withdrawing it = delete.
create table public.votes (
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  post_id uuid references public.posts (id) on delete cascade,
  comment_id uuid references public.comments (id) on delete cascade,
  value smallint not null check (value in (-1, 1)),
  created_at timestamptz not null default now(),
  check ((post_id is null) <> (comment_id is null))
);
comment on table public.votes is 'Votes on posts and comments. RLS: each user sees and changes only their own votes.';
create unique index votes_one_per_post on public.votes (user_id, post_id) where post_id is not null;
create unique index votes_one_per_comment on public.votes (user_id, comment_id) where comment_id is not null;
create index votes_post on public.votes (post_id) where post_id is not null;
create index votes_comment on public.votes (comment_id) where comment_id is not null;

alter table public.votes enable row level security;
create policy "votes: own votes are visible" on public.votes for select to authenticated using ((select auth.uid()) = user_id);
create policy "votes: vote as yourself" on public.votes for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "votes: change your vote" on public.votes for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "votes: withdraw your vote" on public.votes for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.votes from anon, authenticated;
grant select, delete on public.votes to authenticated;
grant insert (post_id, comment_id, value) on public.votes to authenticated;
grant update (value) on public.votes to authenticated;

-- Scores = sum of votes, kept on the target row by this trigger (security definer: voters cannot write scores).
create function public.votes_score()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  delta integer := coalesce(case when tg_op <> 'DELETE' then new.value end, 0) - coalesce(case when tg_op <> 'INSERT' then old.value end, 0);
  p uuid := coalesce(case when tg_op <> 'DELETE' then new.post_id end, old.post_id);
  c uuid := coalesce(case when tg_op <> 'DELETE' then new.comment_id end, old.comment_id);
begin
  if tg_op = 'UPDATE' and (new.post_id is distinct from old.post_id or new.comment_id is distinct from old.comment_id) then
    raise exception 'a vote cannot move to another target' using errcode = '42501';
  end if;
  if p is not null then
    update public.posts set score = score + delta where id = p;
  else
    update public.comments set score = score + delta where id = c;
  end if;
  return null;
end;
$$;
create trigger votes_score after insert or update or delete on public.votes
  for each row execute function public.votes_score();

revoke execute on function public.comments_guard() from public, anon, authenticated;
revoke execute on function public.comments_count() from public, anon, authenticated;
revoke execute on function public.votes_score() from public, anon, authenticated;

-- -------------------------------------------------------------------------------------------------------------- feed
-- Feed rows with the author and a "hot" rank (score decays with age, Reddit-style: sign·log10(max(|s|,1)) + age term).
create view public.post_feed with (security_invoker = true) as
select
  p.*,
  pr.display_name as author_name,
  pr.avatar_url as author_avatar,
  round(sign(p.score::numeric) * log(10::numeric, greatest(abs(p.score), 1)::numeric) + extract(epoch from p.created_at)::numeric / 45000, 7) as hot
from public.posts p
left join public.profiles pr on pr.id = p.author_id;
grant select on public.post_feed to anon, authenticated;

-- ------------------------------------------------------------------------------------------------------------- seeds
-- Discussion starters for the featured investigations. They contain NO figures: each links its analysis (area +
-- window), and the post page shows the measured result read from the TERRATRACE backend.
insert into public.posts (author_id, title, body, tags, aoi_id, baseline, comparison, region, bbox) values
(null, 'Rondônia deforestation frontier: what is driving the 2019–2025 loss?',
 E'TERRATRACE''s featured investigation of the Rondônia frontier (Brazilian Amazon) maps where forest cover changed between 2019 and 2025 using Sentinel-2 and Dynamic World.\n\n**Open questions for discussion**\n\n- Do the loss events follow the classic *fishbone* pattern along roads, or larger clearings typical of pasture expansion?\n- How well do the detected events line up with PRODES / DETER alerts for the same years?\n- Which events are most likely regrowth or seasonal artefacts rather than clearing?\n\nThe measured figures for this window are shown above, straight from the stored analysis. Please cite sources when you bring in outside data.',
 '{deforestation,amazon,brazil,featured}', 'rondonia-frontier', 2019, 2025, 'Rondônia, Brazil', null),
(null, 'Hasdeo Arand: mining expansion and forest loss in a dense sal forest',
 E'Hasdeo Arand (Chhattisgarh, India) is one of central India''s largest contiguous forests and overlaps active coal blocks.\n\n**Discussion prompts**\n\n- Which change events sit inside sanctioned mine lease boundaries, and which fall outside them?\n- Is the detected loss gradual, or concentrated in particular years that match clearance permissions?\n- What field or document evidence (gram sabha records, EIA reports) would help confirm what the satellite sees?\n\nThe measured result for this window appears above this post. Treat it as satellite evidence, not a legal finding.',
 '{mining,india,sal-forest,featured}', 'hasdeo-arand', 2019, 2025, 'Chhattisgarh, India', null),
(null, 'Similipal Biosphere Reserve: fire scars, recovery and real loss',
 E'Similipal (Odisha, India) burns most dry seasons. Burned forest can look like loss in a single year and then recover.\n\n**Let''s discuss**\n\n- How should we separate fire scars that recover from persistent loss in the 2018–2025 record?\n- Are core-zone and buffer-zone trends different?\n- Which seasons or sensors give the clearest view through post-monsoon haze?\n\nThe measured figures for this window are shown above, straight from the stored analysis.',
 '{fire,protected-area,india,featured}', 'similipal', 2018, 2025, 'Odisha, India', null);
