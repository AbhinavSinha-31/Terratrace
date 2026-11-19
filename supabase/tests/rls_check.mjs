// Applies every migration to an in-memory Postgres (PGlite) with a minimal stand-in for Supabase's auth schema,
// then checks the Row Level Security rules as the `anon` and `authenticated` roles. No Docker, no Supabase project.
//   cd supabase && npm install && npm test
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));

// What Supabase provides before any migration runs (only the parts these migrations rely on).
const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb);
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public, auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated;
  -- Supabase grants every new public table to the API roles; RLS and explicit revokes must do the protecting.
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  -- Supabase Storage (only what the avatars migration relies on): buckets, objects with RLS on, storage.foldername().
  create schema storage;
  create table storage.buckets (id text primary key, name text not null, public boolean default false,
                                file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id),
                                name text not null, owner uuid default auth.uid(), unique (bucket_id, name));
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable
    as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
  grant usage on schema storage to anon, authenticated, service_role;
  grant all on storage.objects to anon, authenticated;
  grant select on storage.buckets to anon, authenticated;
  grant execute on function storage.foldername(text) to anon, authenticated;
`;

const db = new PGlite();
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  — ${detail}` : ''}`);
};
const rows = async (sql, params) => (await db.query(sql, params)).rows;
/** Run `sql` as an API role with the given JWT subject; returns rows or the error message. */
async function as(role, sub, sql, params) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${sub ?? ''}', false); set role ${role};`);
  try {
    return { rows: await rows(sql, params) };
  } catch (e) {
    return { error: e.message };
  } finally {
    await db.exec('reset role;');
  }
}

await db.exec(SUPABASE_STUB);
// A user who signed up before the profiles migration (must be backfilled).
const [early] = await rows(`insert into auth.users (email, raw_user_meta_data) values ('early@example.com', '{"full_name":"Early User"}') returning id`);

const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
for (const f of files) await db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
console.log(`applied ${files.length} migration(s): ${files.join(', ')}\n`);

// ---- profiles
const [google] = await rows(`insert into auth.users (email, raw_user_meta_data) values ('g@example.com',
  '{"full_name":"Asha Verma","avatar_url":"https://lh3.googleusercontent.com/a/x"}') returning id`);
const [plain] = await rows(`insert into auth.users (email, raw_user_meta_data) values ('e@example.com', '{}') returning id`);
const [bad] = await rows(`insert into auth.users (email, raw_user_meta_data) values ('b@example.com',
  '{"name":"   ","avatar_url":"javascript:alert(1)"}') returning id`);

const p = Object.fromEntries((await rows('select * from public.profiles')).map((r) => [r.id, r]));
check('sign-up creates a profile (Google name + photo)', p[google.id]?.display_name === 'Asha Verma' && p[google.id]?.avatar_url === 'https://lh3.googleusercontent.com/a/x');
check('sign-up creates a profile (email, no metadata)', p[plain.id] && p[plain.id].display_name === null && p[plain.id].avatar_url === null);
check('blank name and non-https avatar are dropped', p[bad.id] && p[bad.id].display_name === null && p[bad.id].avatar_url === null);
check('users from before the migration are backfilled', p[early.id]?.display_name === 'Early User');

// Since the community migration, profiles (name + photo only; no email column exists) are public so authors can be shown.
let r = await as('anon', null, 'select id, display_name, avatar_url from public.profiles');
check('anyone can read public profile fields (community authors)', r.rows?.length >= 3, JSON.stringify(r));
check('profiles hold no email', !(await rows(`select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name ilike '%mail%'`)).length);
r = await as('anon', null, `update public.profiles set display_name = 'x' returning id`);
check('anon cannot edit profiles', !!r.error || r.rows?.length === 0, JSON.stringify(r));

r = await as('authenticated', google.id, `update public.profiles set display_name = 'Asha V.' where id = $1 returning updated_at, created_at`, [google.id]);
check('a user can rename themselves', r.rows?.length === 1, JSON.stringify(r));
check('updated_at moves on update', r.rows?.[0] && r.rows[0].updated_at >= r.rows[0].created_at);

r = await as('authenticated', google.id, `update public.profiles set display_name = 'hacked' where id = $1 returning id`, [plain.id]);
check("a user cannot edit someone else's profile", r.rows?.length === 0, JSON.stringify(r));
check("…and the other profile is unchanged", (await rows('select display_name from public.profiles where id = $1', [plain.id]))[0].display_name === null);

r = await as('authenticated', google.id, `update public.profiles set id = $2 where id = $1`, [google.id, plain.id]);
check('a user cannot change their profile id', !!r.error, JSON.stringify(r));
r = await as('authenticated', google.id, `update public.profiles set created_at = now() - interval '1 year' where id = $1`, [google.id]);
check('a user cannot change created_at', !!r.error, JSON.stringify(r));

r = await as('authenticated', google.id, `insert into public.profiles (id) values (gen_random_uuid())`);
check('a user cannot insert profiles', !!r.error, JSON.stringify(r));
r = await as('authenticated', google.id, `delete from public.profiles where id = $1`, [google.id]);
check('a user cannot delete profiles', !!r.error, JSON.stringify(r));

r = await as('authenticated', google.id, `update public.profiles set avatar_url = 'javascript:alert(1)' where id = $1`, [google.id]);
check('a non-https avatar is rejected', !!r.error, JSON.stringify(r));
r = await as('authenticated', google.id, `update public.profiles set display_name = '' where id = $1`, [google.id]);
check('an empty display name is rejected', !!r.error, JSON.stringify(r));

r = await as('authenticated', google.id, `select public.handle_new_user()`);
check('the sign-up trigger function is not callable by users', !!r.error, JSON.stringify(r));

// ---- saved_scans ("My scans")
const scan = `insert into public.saved_scans (aoi_id, name, baseline, comparison, summary, bbox)
  values ($1, 'Rondônia 2019–2025', 2019, 2025, '{"status":"READY","net_change_ha":-1234.5}', '{-63.1,-10.2,-62.6,-9.8}') returning id, user_id`;
r = await as('authenticated', google.id, scan, ['rondonia-frontier']);
check('a user can save a scan (owner set from the token)', r.rows?.[0]?.user_id === google.id, JSON.stringify(r));
const scanId = r.rows?.[0]?.id;
r = await as('authenticated', google.id, scan, ['rondonia-frontier']);
check('the same area + window is saved once per user', !!r.error, JSON.stringify(r));
r = await as('authenticated', early.id, `insert into public.saved_scans (user_id, aoi_id, name, baseline, comparison) values ($1, 'similipal', 'x', 2018, 2025)`, [google.id]);
check("a user cannot save a scan as someone else", !!r.error, JSON.stringify(r));
r = await as('authenticated', early.id, 'select id from public.saved_scans');
check("a user cannot see someone else's scans", r.rows?.length === 0, JSON.stringify(r));
r = await as('anon', null, 'select id from public.saved_scans');
check('anon cannot read saved scans', !!r.error || r.rows?.length === 0, JSON.stringify(r));
r = await as('authenticated', early.id, 'delete from public.saved_scans where id = $1 returning id', [scanId]);
check("a user cannot delete someone else's scan", r.rows?.length === 0, JSON.stringify(r));
r = await as('authenticated', google.id, `update public.saved_scans set aoi_id = 'similipal' where id = $1`, [scanId]);
check('a saved scan cannot be moved to another area', !!r.error, JSON.stringify(r));
r = await as('authenticated', google.id, `insert into public.saved_scans (aoi_id, name, baseline, comparison) values ('../etc', 'x', 2018, 2025)`);
check('an invalid area id is rejected', !!r.error, JSON.stringify(r));
r = await as('authenticated', google.id, `insert into public.saved_scans (aoi_id, name, baseline, comparison) values ('similipal', 'x', 2025, 2018)`);
check('a reversed window is rejected', !!r.error, JSON.stringify(r));
r = await as('authenticated', google.id, `update public.saved_scans set name = 'Renamed' where id = $1 returning name`, [scanId]);
check('the owner can rename a scan', r.rows?.[0]?.name === 'Renamed', JSON.stringify(r));
r = await as('authenticated', google.id, 'delete from public.saved_scans where id = $1 returning id', [scanId]);
check('the owner can delete a scan', r.rows?.length === 1, JSON.stringify(r));

// ---- community: posts, threaded comments, votes
const seeds = await rows(`select title, aoi_id, author_id from public.posts order by created_at`);
check('three seed posts exist (Rondônia, Hasdeo Arand, Similipal)', seeds.length === 3 && ['rondonia-frontier', 'hasdeo-arand', 'similipal'].every((a) => seeds.some((s) => s.aoi_id === a)), JSON.stringify(seeds));
check('seed posts contain no invented figures (no ha / km / % numbers)', !(await rows(`select 1 from public.posts where body ~ '[0-9]+([.][0-9]+)?[[:space:]]*(ha|km|%)'`)).length);

r = await as('anon', null, `select id, title, author_name, hot from public.post_feed order by hot desc`);
check('guests can read the feed (with author and hot rank)', r.rows?.length === 3, JSON.stringify(r));
r = await as('anon', null, `insert into public.posts (title, body) values ('Guest post', 'x') returning id`);
check('guests cannot post', !!r.error, JSON.stringify(r));

const post = `insert into public.posts (title, body, tags, aoi_id, baseline, comparison, region) values ($1, $2, $3, 'similipal', 2018, 2025, 'Odisha') returning id, author_id, score`;
r = await as('authenticated', google.id, post, ['Fire scars in 2021', 'Look at **2021**.', ['fire', 'india']]);
const myPost = r.rows?.[0];
check('a signed-in user can post (author set from the token)', myPost?.author_id === google.id && myPost?.score === 0, JSON.stringify(r));
r = await as('authenticated', google.id, `insert into public.posts (author_id, title, body) values ($1, 'Impersonation', 'x')`, [early.id]);
check('a user cannot post as someone else', !!r.error, JSON.stringify(r));
r = await as('authenticated', google.id, `insert into public.posts (title, body, score) values ('Rigged', 'x', 999)`);
check('a user cannot set a score on insert', !!r.error, JSON.stringify(r));
r = await as('authenticated', google.id, post, ['Bad tags', 'x', ['Not Valid!']]);
check('invalid tags are rejected', !!r.error, JSON.stringify(r));
r = await as('authenticated', google.id, `update public.posts set score = 999 where id = $1`, [myPost.id]);
check('a user cannot change a score directly', !!r.error, JSON.stringify(r));
r = await as('authenticated', early.id, `update public.posts set title = 'hijacked' where id = $1 returning id`, [myPost.id]);
check("a user cannot edit someone else's post", r.rows?.length === 0, JSON.stringify(r));
r = await as('authenticated', google.id, `update public.posts set title = 'Fire scars in 2021 (edited)' where id = $1 returning title`, [myPost.id]);
check('the author can edit their post', r.rows?.[0]?.title.endsWith('(edited)'), JSON.stringify(r));

// a post can link only the author's own saved scan
const [otherScan] = await rows(`insert into public.saved_scans (user_id, aoi_id, name, baseline, comparison) values ($1, 'similipal', 's', 2018, 2025) returning id`, [early.id]);
r = await as('authenticated', google.id, `insert into public.posts (title, body, scan_id) values ('Borrowed scan', 'x', $1)`, [otherScan.id]);
check("a post cannot link someone else's saved scan", !!r.error, JSON.stringify(r));

// threaded comments
r = await as('authenticated', early.id, `insert into public.comments (post_id, body) values ($1, 'Top-level comment') returning id, author_id`, [myPost.id]);
const top = r.rows?.[0];
check('a signed-in user can comment', top?.author_id === early.id, JSON.stringify(r));
r = await as('authenticated', google.id, `insert into public.comments (post_id, parent_id, body) values ($1, $2, 'A reply') returning id`, [myPost.id, top.id]);
const reply = r.rows?.[0];
check('a user can reply (threaded)', !!reply, JSON.stringify(r));
const [seedPost] = await rows(`select id from public.posts where aoi_id = 'rondonia-frontier'`);
r = await as('authenticated', google.id, `insert into public.comments (post_id, parent_id, body) values ($1, $2, 'cross-post reply')`, [seedPost.id, top.id]);
check('a reply must belong to the same post as its parent', !!r.error, JSON.stringify(r));
r = await as('anon', null, `select body from public.comments where post_id = $1 order by created_at`, [myPost.id]);
check('guests can read comments', r.rows?.length === 2, JSON.stringify(r));
check('comment_count follows comments', (await rows('select comment_count from public.posts where id = $1', [myPost.id]))[0].comment_count === 2);
r = await as('anon', null, `insert into public.comments (post_id, body) values ($1, 'guest')`, [myPost.id]);
check('guests cannot comment', !!r.error, JSON.stringify(r));
r = await as('authenticated', google.id, `update public.comments set body = 'edited by someone else' where id = $1 returning id`, [top.id]);
check("a user cannot edit someone else's comment", r.rows?.length === 0, JSON.stringify(r));
r = await as('authenticated', early.id, `update public.comments set deleted = true where id = $1 returning body, deleted`, [top.id]);
check('soft delete keeps the thread and blanks the body', r.rows?.[0]?.body === '[deleted]' && r.rows[0].deleted === true, JSON.stringify(r));
r = await as('authenticated', early.id, `update public.comments set deleted = false, body = 'back' where id = $1`, [top.id]);
check('a deleted comment cannot be revived', !!r.error, JSON.stringify(r));
check('…and its reply is still there', (await rows('select 1 from public.comments where id = $1', [reply.id])).length === 1);

// votes: +1/-1, one per user per target, score kept by trigger
const score = async (t, id) => (await rows(`select score from public.${t} where id = $1`, [id]))[0].score;
r = await as('authenticated', early.id, `insert into public.votes (post_id, value) values ($1, 1)`, [myPost.id]);
check('a user can upvote a post', !r.error && (await score('posts', myPost.id)) === 1, JSON.stringify(r));
r = await as('authenticated', early.id, `insert into public.votes (post_id, value) values ($1, 1)`, [myPost.id]);
check('one vote per user per post', !!r.error && (await score('posts', myPost.id)) === 1, JSON.stringify(r));
r = await as('authenticated', early.id, `update public.votes set value = -1 where post_id = $1`, [myPost.id]);
check('changing a vote moves the score by 2', !r.error && (await score('posts', myPost.id)) === -1, JSON.stringify(r));
r = await as('authenticated', google.id, `insert into public.votes (post_id, value) values ($1, 5)`, [myPost.id]);
check('a vote is only +1 or -1', !!r.error, JSON.stringify(r));
r = await as('authenticated', google.id, `insert into public.votes (user_id, post_id, value) values ($1, $2, 1)`, [early.id, seedPost.id]);
check('a user cannot vote as someone else', !!r.error, JSON.stringify(r));
r = await as('authenticated', google.id, `select * from public.votes`);
check("a user cannot see other people's votes", r.rows?.length === 0, JSON.stringify(r));
r = await as('authenticated', early.id, `delete from public.votes where post_id = $1`, [myPost.id]);
check('withdrawing a vote restores the score', !r.error && (await score('posts', myPost.id)) === 0, JSON.stringify(r));
r = await as('authenticated', google.id, `insert into public.votes (comment_id, value) values ($1, 1)`, [reply.id]);
check('comments can be voted on', !r.error && (await score('comments', reply.id)) === 1, JSON.stringify(r));
r = await as('authenticated', google.id, `insert into public.votes (post_id, comment_id, value) values ($1, $2, 1)`, [myPost.id, reply.id]);
check('a vote targets exactly one post or comment', !!r.error, JSON.stringify(r));
r = await as('anon', null, `insert into public.votes (post_id, value) values ($1, 1)`, [myPost.id]);
check('guests cannot vote', !!r.error, JSON.stringify(r));

// search, tags, delete
r = await as('anon', null, `select title from public.post_feed where search @@ websearch_to_tsquery('english', 'fire scars')`);
check('full-text search finds posts', r.rows?.some((x) => x.title.startsWith('Fire scars')), JSON.stringify(r));
r = await as('anon', null, `select title from public.post_feed where tags @> '{mining}'`);
check('tag filter works', r.rows?.length === 1 && r.rows[0].title.startsWith('Hasdeo'), JSON.stringify(r));
r = await as('authenticated', early.id, `delete from public.posts where id = $1 returning id`, [myPost.id]);
check("a user cannot delete someone else's post", r.rows?.length === 0, JSON.stringify(r));
r = await as('authenticated', google.id, `delete from public.posts where id = $1 returning id`, [myPost.id]);
check('the author can delete their post (comments and votes go with it)', r.rows?.length === 1 && !(await rows('select 1 from public.comments where post_id = $1', [myPost.id])).length);
r = await as('authenticated', google.id, `select public.votes_score()`);
check('trigger functions are not callable by users', !!r.error, JSON.stringify(r));

await db.exec(`delete from auth.users where id = '${plain.id}'`);
check('deleting the auth user deletes the profile', (await rows('select 1 from public.profiles where id = $1', [plain.id])).length === 0);

// ---- avatars storage (20261120090000_avatars_storage.sql)
const [bucket] = await rows(`select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'avatars'`);
check('the avatars bucket exists, public, 2 MB, images only', bucket?.public === true && Number(bucket.file_size_limit) === 2097152 && bucket.allowed_mime_types.includes('image/png'), JSON.stringify(bucket));
r = await as('authenticated', google.id, `insert into storage.objects (bucket_id, name) values ('avatars', $1) returning id`, [`${google.id}/avatar`]);
check('a user can upload their own avatar', r.rows?.length === 1, JSON.stringify(r));
r = await as('authenticated', google.id, `insert into storage.objects (bucket_id, name) values ('avatars', $1)`, [`${early.id}/avatar`]);
check("a user cannot upload into someone else's folder", !!r.error, JSON.stringify(r));
r = await as('authenticated', google.id, `insert into storage.objects (bucket_id, name) values ('avatars', 'avatar')`);
check('a file outside any user folder is refused', !!r.error, JSON.stringify(r));
r = await as('anon', null, `insert into storage.objects (bucket_id, name) values ('avatars', $1)`, [`${google.id}/x`]);
check('guests cannot upload', !!r.error, JSON.stringify(r));
r = await as('authenticated', early.id, `update storage.objects set name = name where bucket_id = 'avatars' and name = $1 returning id`, [`${google.id}/avatar`]);
check("a user cannot replace someone else's avatar", r.rows?.length === 0, JSON.stringify(r));
r = await as('authenticated', early.id, `delete from storage.objects where bucket_id = 'avatars' and name = $1 returning id`, [`${google.id}/avatar`]);
check("a user cannot delete someone else's avatar", r.rows?.length === 0, JSON.stringify(r));
r = await as('anon', null, `select name from storage.objects where bucket_id = 'avatars'`);
check('nobody can list the bucket through the API (public URLs only)', r.rows?.length === 0, JSON.stringify(r));
r = await as('authenticated', google.id, `select name from storage.objects where bucket_id = 'avatars'`);
check('the owner sees only their own file (needed for replace)', r.rows?.length === 1 && r.rows[0].name === `${google.id}/avatar`, JSON.stringify(r));
r = await as('authenticated', google.id, `update public.profiles set avatar_url = 'https://kmjranrbtlxbsvrtpxpl.supabase.co/storage/v1/object/public/avatars/x/avatar?v=1' where id = $1 returning avatar_url`, [google.id]);
check('the public Storage URL can be saved as avatar_url', r.rows?.length === 1, JSON.stringify(r));
r = await as('anon', null, `select author_avatar from public.post_feed limit 1`);
check('post_feed exposes author_name and author_avatar', !r.error, JSON.stringify(r));
let twice = null;
try { await db.exec(readFileSync(join(MIGRATIONS, '20261120090000_avatars_storage.sql'), 'utf8')); } catch (e) { twice = e.message; }
check('the avatars migration can be run again safely', twice === null, twice ?? '');

// ---- repair migration (20261118090000_repair_data_api.sql): idempotent, and explicit when tables are missing
const repair = readFileSync(join(MIGRATIONS, '20261118090000_repair_data_api.sql'), 'utf8');
let again = null;
try { await db.exec(repair); } catch (e) { again = e.message; }
check('the repair migration can be run again safely', again === null, again ?? '');
r = await as('anon', null, 'select count(*)::int as n from public.post_feed');
check('…and guests still read the feed afterwards', r.rows?.[0]?.n >= 3, JSON.stringify(r));
const empty = new PGlite();
await empty.exec(SUPABASE_STUB);
let missingMsg = '';
try { await empty.exec(repair); } catch (e) { missingMsg = e.message; }
check('on a database without the tables it names what is missing',
  /missing in this database: profiles, saved_scans, posts, comments, votes, post_feed/.test(missingMsg), missingMsg);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
