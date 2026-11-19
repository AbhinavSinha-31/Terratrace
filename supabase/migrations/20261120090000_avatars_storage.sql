-- Profile photos: a public Supabase Storage bucket "avatars". Safe to run more than once.
--
-- Layout: avatars/<user id>/avatar (one object per user, replaced on every upload). The app saves the object's public
-- URL (+ ?v=<time> to bust caches) in profiles.avatar_url, which public.post_feed already returns as author_avatar
-- (and the comments query reads through its profiles join) — so no view or table change is needed here.
--
-- Read: anyone, through the public URL (bucket.public = true). There is deliberately NO select policy for anon:
--       a public bucket serves files without one, and a broad select policy would let anyone LIST every user's files.
-- Write: a signed-in user may create, replace or delete objects only inside their own folder <auth.uid()>/.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "avatars: owner can read own files" on storage.objects;
drop policy if exists "avatars: owner can upload" on storage.objects;
drop policy if exists "avatars: owner can replace" on storage.objects;
drop policy if exists "avatars: owner can delete" on storage.objects;

-- Needed by "upsert" uploads (replace the existing file) — the owner sees only their own folder.
create policy "avatars: owner can read own files" on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "avatars: owner can upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "avatars: owner can replace" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "avatars: owner can delete" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
