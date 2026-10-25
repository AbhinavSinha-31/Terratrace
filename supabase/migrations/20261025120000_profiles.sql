-- User profiles: one row per Supabase auth user, created by a trigger on sign-up (Google or email).
-- Signed-in users can read and edit only their own row; anonymous visitors cannot read profiles at all.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) between 1 and 80),
  -- Only https images (Google profile photos); never javascript:/data: URLs.
  avatar_url text check (avatar_url ~ '^https://' and char_length(avatar_url) <= 2048),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is 'TERRATRACE user profile (one per auth.users row). RLS: owner only.';

alter table public.profiles enable row level security;

-- No insert or delete policies: rows are created by handle_new_user() and removed with the auth user (cascade).
create policy "profiles: owner can read"
  on public.profiles for select to authenticated
  using ((select auth.uid()) = id);

create policy "profiles: owner can update"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- Table privileges on top of RLS: anon gets nothing; signed-in users may change only the editable columns.
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, avatar_url) on public.profiles to authenticated;

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Runs as the table owner (security definer) because the new user has no insert privilege on profiles.
-- Google sign-in supplies full_name/name and avatar_url; email sign-up may supply full_name.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  full_name text := nullif(btrim(coalesce(meta ->> 'full_name', meta ->> 'name')), '');
  avatar text := meta ->> 'avatar_url';
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    left(full_name, 80),
    case when avatar ~ '^https://' and char_length(avatar) <= 2048 then avatar end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Users who signed up before this migration get a profile too.
insert into public.profiles (id, display_name, avatar_url)
select
  u.id,
  left(nullif(btrim(coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name')), ''), 80),
  case when u.raw_user_meta_data ->> 'avatar_url' ~ '^https://'
        and char_length(u.raw_user_meta_data ->> 'avatar_url') <= 2048
       then u.raw_user_meta_data ->> 'avatar_url' end
from auth.users u
on conflict (id) do nothing;
