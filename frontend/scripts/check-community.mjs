#!/usr/bin/env node
/**
 * Community UI check against an in-memory fake of Supabase (auth + the PostgREST tables the community uses), so no real
 * project is touched. Row Level Security itself is tested in supabase/tests (npm test there).
 *
 *   VITE_SUPABASE_URL=https://tt-auth-test.supabase.co VITE_SUPABASE_ANON_KEY=sb_publishable_test npm run build
 *   npx vite preview --port 5184 & TT_URL=http://127.0.0.1:5184/ npm run test:community
 */
import { chromium } from 'playwright-core';

const BASE = process.env.TT_URL ?? 'http://localhost:5173/';
const channel = process.env.TT_BROWSER ?? 'msedge';
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  — ${detail}` : ''}`);
};

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const USER_ID = '6f1c2a4e-1d2b-4c3d-9e8f-0a1b2c3d4e5f';
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const user = { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'reader@example.com', created_at: now(), app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {} };
const session = () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return { access_token: `${b64({ alg: 'ES256', typ: 'JWT' })}.${b64({ sub: USER_ID, role: 'authenticated', exp })}.sig`, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'r', user };
};

// ---- fake database
const SEED = uuid();
const db = {
  signedIn: false,
  posts: [{ id: SEED, author_id: null, author_name: null, author_avatar: null, title: 'Rondônia deforestation frontier: what is driving the 2019–2025 loss?', body: 'Open questions for **discussion**.', tags: ['deforestation', 'amazon'], scan_id: null, aoi_id: 'rondonia-frontier', baseline: 2019, comparison: 2025, region: 'Rondônia, Brazil', bbox: null, score: 0, comment_count: 0, created_at: '2026-11-17T08:00:00Z', updated_at: '2026-11-17T08:00:00Z' }],
  comments: [],
  votes: [],
  writes: [],
};
const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const eqParam = (url, col) => url.searchParams.get(col)?.replace(/^eq\./, '');

async function fake(context) {
  await context.route(/\/auth\/v1\//, async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/auth\/v1/, '');
    if (path === '/token') { db.signedIn = true; return json(route, 200, session()); }
    if (path === '/user') return json(route, 200, user);
    if (path === '/logout') { db.signedIn = false; return route.fulfill({ status: 204 }); }
    return json(route, 404, {});
  });
  await context.route(/\/rest\/v1\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const table = url.pathname.split('/rest/v1/')[1];
    const method = req.method();
    const single = (req.headers().accept ?? '').includes('vnd.pgrst.object');
    const authed = (req.headers().authorization ?? '').includes(b64({ alg: 'ES256', typ: 'JWT' }));
    if (method !== 'GET') {
      db.writes.push({ table, method, body: req.postDataJSON?.() ?? null, authed });
      if (!authed) return json(route, 401, { code: '42501', message: 'permission denied' });
    }
    if (table === 'profiles') return json(route, 200, single ? { id: USER_ID, display_name: 'Reader One', avatar_url: null, created_at: now(), updated_at: now() } : []);
    if (table === 'saved_scans') return json(route, 200, []);
    if (table === 'post_feed') {
      const id = eqParam(url, 'id');
      let rows = db.posts.filter((p) => !id || p.id === id);
      if (url.searchParams.get('tags')) { const t = url.searchParams.get('tags').match(/\{(.*)\}/)[1]; rows = rows.filter((p) => p.tags.includes(t)); }
      return json(route, 200, single || url.searchParams.get('id') ? rows[0] ?? null : rows);
    }
    if (table === 'posts' && method === 'POST') {
      const body = req.postDataJSON();
      const p = { id: uuid(), author_id: USER_ID, author_name: 'Reader One', author_avatar: null, score: 0, comment_count: 0, created_at: now(), updated_at: now(), tags: [], scan_id: null, aoi_id: null, baseline: null, comparison: null, region: null, bbox: null, ...body };
      db.posts.unshift(p);
      return json(route, 201, single ? { id: p.id } : [{ id: p.id }]);
    }
    if (table === 'comments' && method === 'GET') {
      const pid = eqParam(url, 'post_id');
      return json(route, 200, db.comments.filter((c) => c.post_id === pid).map((c) => ({ ...c, author: { display_name: 'Reader One', avatar_url: null } })));
    }
    if (table === 'comments' && method === 'POST') {
      const body = req.postDataJSON();
      db.comments.push({ id: uuid(), author_id: USER_ID, deleted: false, score: 0, created_at: now(), updated_at: now(), parent_id: null, ...body });
      const p = db.posts.find((x) => x.id === body.post_id); if (p) p.comment_count++;
      return route.fulfill({ status: 201 });
    }
    if (table === 'votes') {
      if (method === 'GET') return json(route, 200, db.votes);
      const body = method === 'DELETE' ? null : req.postDataJSON();
      const target = (pid, cid) => (pid ? db.posts.find((p) => p.id === pid) : db.comments.find((c) => c.id === cid));
      if (method === 'POST') {
        if (db.votes.some((v) => v.post_id === (body.post_id ?? null) && v.comment_id === (body.comment_id ?? null))) return json(route, 409, { code: '23505' });
        db.votes.push({ post_id: body.post_id ?? null, comment_id: body.comment_id ?? null, value: body.value });
        target(body.post_id, body.comment_id).score += body.value;
      } else {
        const pid = eqParam(url, 'post_id'); const cid = eqParam(url, 'comment_id');
        const v = db.votes.find((x) => (pid ? x.post_id === pid : x.comment_id === cid));
        if (v) {
          target(v.post_id, v.comment_id).score += (method === 'DELETE' ? 0 : body.value) - v.value;
          if (method === 'DELETE') db.votes.splice(db.votes.indexOf(v), 1); else v.value = body.value;
        }
      }
      return route.fulfill({ status: 204 });
    }
    return json(route, 404, { message: `unmocked ${table}` });
  });
  // The analysis card reads the stored result from the TERRATRACE backend.
  await context.route(/\/api\/analysis-status\//, (route) => json(route, 200, { status: 'READY', kpis: { net_change_ha: -2500, gross_loss_ha: 2700, gross_gain_ha: 200, event_count: 14 } }));
}

const browser = await chromium.launch({ channel, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1366, height: 860 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await fake(context);
const visible = (id, timeout = 8000) => page.getByTestId(id).first().waitFor({ state: 'visible', timeout }).then(() => true, () => false);
const hash = () => new URL(page.url()).hash;

try {
  // guest reads
  await page.goto(`${BASE}#/`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Community' }).click();
  check('Community nav opens #/community with the feed', (await visible('post-card')) && hash() === '#/community', hash());
  const navHeights = await page.getByRole('navigation', { name: 'Primary' }).getByRole('button').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  check('nav labels stay on one line at 1366 px', navHeights.every((h) => h <= 64), JSON.stringify(navHeights));
  await page.getByTestId('post-link').first().click();
  check('a guest can open a post', (await visible('post-page')) && hash().startsWith('#/community/'), hash());
  check('the linked analysis shows figures from the backend', (await visible('analysis-card')) && await page.getByTestId('analysis-card').getByText('−2,500 ha').isVisible());
  check('guests see "sign in to join" instead of a comment box', await visible('comment-sign-in'));
  await page.getByTestId('upvote').first().click();
  check('a guest vote opens the sign-in dialog and writes nothing', (await visible('sign-in-dialog')) && db.writes.length === 0, JSON.stringify(db.writes));

  // sign in from the prompt, then vote
  const form = page.getByTestId('sign-in-form');
  await form.getByLabel('Email').fill('reader@example.com');
  await form.getByLabel('Password').fill('pw');
  await form.getByRole('button', { name: 'Sign in' }).click();
  await page.getByTestId('sign-in-dialog').waitFor({ state: 'detached', timeout: 8000 });
  await page.getByTestId('upvote').first().click();
  await page.waitForTimeout(500);
  check('a signed-in upvote inserts one vote (+1)', db.votes.length === 1 && db.votes[0].value === 1 && db.posts[0].score === 1, JSON.stringify(db.votes));
  await page.getByTestId('downvote').first().click();
  await page.waitForTimeout(500);
  check('switching to a downvote updates the same vote (-1)', db.votes.length === 1 && db.votes[0].value === -1 && db.posts.find((p) => p.id === SEED).score === -1, JSON.stringify(db.votes));

  // comment + threaded reply
  await page.getByTestId('comment-form').getByLabel('Comment').fill('The road network matters **a lot** here.');
  await page.getByTestId('comment-form').getByRole('button', { name: 'Comment' }).click();
  check('a comment is posted and rendered as markdown', await page.getByTestId('comment').locator('strong', { hasText: 'a lot' }).waitFor({ timeout: 8000 }).then(() => true, () => false));
  await page.getByTestId('reply').first().click();
  await page.getByTestId('reply-form').getByLabel('Reply').fill('Agreed — see the fishbone pattern.');
  await page.getByTestId('reply-form').getByRole('button', { name: 'Reply' }).click();
  await page.getByText('Agreed — see the fishbone pattern.').waitFor({ timeout: 8000 });
  const reply = db.comments.find((c) => c.body.startsWith('Agreed'));
  check('a reply is stored under its parent (threaded)', !!reply && reply.parent_id === db.comments[0].id, JSON.stringify(db.comments));
  await page.waitForTimeout(800);
  const nested = await page.getByTestId('comment').first().getByTestId('comment').count();
  check('the reply is nested under its parent in the page', nested === 1, `nested=${nested} total=${await page.getByTestId('comment').count()} html=${(await page.getByTestId('comment').first().innerHTML()).slice(0, 300)}`);

  // new post from "Discuss" (pre-filled analysis) → publish → post page
  await page.goto(`${BASE}#/community/new`, { waitUntil: 'domcontentloaded' });
  await visible('new-post-form');
  await page.getByLabel('Title').fill('Similipal fire scars in 2021');
  await page.getByLabel('Body (markdown)').fill('Which of these recover by **2023**?');
  await page.getByLabel('Tags').fill('fire india');
  await page.getByTestId('publish-post').click();
  check('publishing opens the new post', await page.getByTestId('post-title').filter({ hasText: 'Similipal fire scars in 2021' }).waitFor({ timeout: 8000 }).then(() => true, () => false));
  const created = db.writes.find((w) => w.table === 'posts' && w.method === 'POST');
  check('the post is sent with its tags and without author or score fields', !!created && JSON.stringify(created.body.tags) === '["fire","india"]' && !('author_id' in created.body) && !('score' in created.body), JSON.stringify(created?.body));

  // tag filter
  await page.goto(`${BASE}#/community?tag=deforestation`, { waitUntil: 'domcontentloaded' });
  await visible('post-card');
  check('a tag link filters the feed', (await page.getByTestId('post-card').count()) === 1 && hash() === '#/community?tag=deforestation');

  // phone
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}#/community`, { waitUntil: 'domcontentloaded' });
  await visible('post-card');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('no horizontal scroll at 390 px', overflow <= 0, String(overflow));
  check('no uncaught page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('test ran to completion', false, e.message);
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
