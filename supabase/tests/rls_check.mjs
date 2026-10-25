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

let r = await as('anon', null, 'select * from public.profiles');
check('anon cannot read profiles', !!r.error, JSON.stringify(r));

r = await as('authenticated', google.id, 'select id from public.profiles');
check('a user sees only their own profile', r.rows?.length === 1 && r.rows[0].id === google.id, JSON.stringify(r));

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

await db.exec(`delete from auth.users where id = '${plain.id}'`);
check('deleting the auth user deletes the profile', (await rows('select 1 from public.profiles where id = $1', [plain.id])).length === 0);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
