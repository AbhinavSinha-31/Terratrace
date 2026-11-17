#!/usr/bin/env node
/**
 * Sign-in / profile UI check. Every Supabase request (/auth/v1, /rest/v1) is answered here, so no real project is
 * touched and no account is needed. Row Level Security itself is tested in supabase/tests (npm test there).
 *
 *   # a build WITH Supabase settings (any values: requests never leave the browser)
 *   VITE_SUPABASE_URL=https://tt-auth-test.supabase.co VITE_SUPABASE_ANON_KEY=sb_publishable_test VITE_AUTH_GOOGLE=true npm run build
 *   npx vite preview --port 5174 & TT_URL=http://127.0.0.1:5174/ npm run test:auth
 *
 *   # a build WITHOUT them: sign-in must show as unavailable and the rest of the app must still load
 *   npm run build && npx vite preview --port 5174 & TT_URL=http://127.0.0.1:5174/ TT_AUTH_EXPECT=unconfigured npm run test:auth
 */
import { chromium } from 'playwright-core';

const BASE = process.env.TT_URL ?? 'http://localhost:5173/';
const channel = process.env.TT_BROWSER ?? 'msedge';
const unconfigured = process.env.TT_AUTH_EXPECT === 'unconfigured';

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  — ${detail}` : ''}`);
};

// ---- a fake Supabase project
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const USER_ID = '6f1c2a4e-1d2b-4c3d-9e8f-0a1b2c3d4e5f';
const user = (email, provider = 'email') => ({
  id: USER_ID, aud: 'authenticated', role: 'authenticated', email, created_at: '2026-10-25T10:00:00Z',
  app_metadata: { provider, providers: [provider] },
  user_metadata: provider === 'google' ? { full_name: 'Asha Verma', avatar_url: 'https://lh3.googleusercontent.com/a/test' } : {},
});
const session = (u) => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return {
    access_token: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: u.id, role: 'authenticated', exp, email: u.email })}.sig`,
    token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'refresh-test', user: u,
  };
};
const state = { profile: null, signedIn: null, calls: [], scans: [] };
const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function fakeSupabase(context) {
  await context.route(/\/auth\/v1\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const body = req.postDataJSON?.() ?? null;
    state.calls.push({ method: req.method(), path: url.pathname, query: url.search, body, headers: req.headers() });
    const path = url.pathname.replace(/^.*\/auth\/v1/, '');
    if (path === '/authorize') {
      // Google: send the browser straight back to the app with a code, as Supabase would after Google's consent screen.
      const back = new URL(url.searchParams.get('redirect_to'));
      back.searchParams.set('code', 'google-code');
      return route.fulfill({ status: 302, headers: { location: back.toString() } });
    }
    if (path === '/token') {
      const grant = url.searchParams.get('grant_type');
      if (grant === 'password') {
        if (body.password !== 'correct-horse') return json(route, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials', code: 'invalid_credentials', msg: 'Invalid login credentials' });
        state.signedIn = user(body.email);
        return json(route, 200, session(state.signedIn));
      }
      if (grant === 'pkce') {
        state.signedIn = body.auth_code === 'google-code' ? user('asha@example.com', 'google') : user('reader@example.com');
        return json(route, 200, session(state.signedIn));
      }
      if (grant === 'refresh_token') return json(route, 200, session(state.signedIn ?? user('reader@example.com')));
    }
    if (path === '/signup') return json(route, 200, { ...user(body.email), identities: [{ provider: 'email' }], confirmation_sent_at: new Date().toISOString() });
    if (path === '/recover') return json(route, 200, {});
    if (path === '/otp') return json(route, 200, {});
    if (path === '/user' && req.method() === 'PUT') return json(route, 200, state.signedIn);
    if (path === '/user') return json(route, 200, state.signedIn);
    if (path === '/logout') { state.signedIn = null; return route.fulfill({ status: 204 }); }
    return json(route, 404, { msg: `unmocked ${path}` });
  });
  await context.route(/\/rest\/v1\/saved_scans/, async (route) => {
    const req = route.request();
    state.calls.push({ method: req.method(), path: '/rest/v1/saved_scans', query: new URL(req.url()).search, body: req.postDataJSON?.() ?? null, headers: req.headers() });
    return json(route, 200, state.scans);
  });
  await context.route(/\/rest\/v1\/profiles/, async (route) => {
    const req = route.request();
    const single = (req.headers().accept ?? '').includes('vnd.pgrst.object');
    state.calls.push({ method: req.method(), path: '/rest/v1/profiles', query: new URL(req.url()).search, body: req.postDataJSON?.() ?? null, headers: req.headers() });
    if (req.method() === 'PATCH') state.profile = { ...state.profile, ...req.postDataJSON(), updated_at: new Date().toISOString() };
    const rows = state.profile ? [state.profile] : [];
    return json(route, 200, single ? rows[0] : rows);
  });
}
const lastCall = (pathPart, method) => [...state.calls].reverse().find((c) => c.path.endsWith(pathPart) && (!method || c.method === method));

const browser = await chromium.launch({ channel, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await fakeSupabase(context);
const hash = () => new URL(page.url()).hash;
const visible = (testId, timeout = 8000) => page.getByTestId(testId).waitFor({ state: 'visible', timeout }).then(() => true, () => false);

try {
  await page.goto(`${BASE}#/`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('account-button').click();

  if (unconfigured) {
    check('menu says accounts are not available', await page.getByText('Accounts are not available yet').isVisible());
    check('menu offers no sign-in', (await page.getByTestId('menu-sign-in').count()) === 0);
    await page.goto(`${BASE}#/profile`, { waitUntil: 'domcontentloaded' });
    check('#/profile explains that accounts are off', await page.getByTestId('profile-page').getByText('Accounts are not available yet').isVisible());
    check('no Supabase request was made', state.calls.length === 0, JSON.stringify(state.calls.map((c) => c.path)));
  } else {
    // 1. signed out → Sign in → the sign-in dialog (the page underneath stays where it was)
    check('signed-out menu offers Sign in', await visible('menu-sign-in'));
    await page.getByTestId('menu-sign-in').click();
    check('Sign in opens the sign-in dialog', (await visible('sign-in-dialog')) && (await visible('sign-in-form')) && hash() === '#/', hash());
    check('Google is offered when the build enables it', await visible('google-sign-in'));

    // 1b. magic link
    await page.getByTestId('magic-link-mode').click();
    await page.getByTestId('magic-form').getByLabel('Email').fill('reader@example.com');
    await page.getByTestId('magic-form').getByRole('button', { name: 'Email me a sign-in link' }).click();
    check('magic link shows the link-sent notice', await page.getByText('We emailed a sign-in link to reader@example.com').waitFor({ timeout: 8000 }).then(() => true, () => false));
    const otp = lastCall('/otp');
    check("magic link asks Supabase with PKCE and the app's return URL", otp?.body?.email === 'reader@example.com' && otp?.body?.create_user === true && !!otp?.body?.code_challenge, JSON.stringify(otp?.body));
    await page.getByRole('button', { name: 'Back to sign in' }).click();

    // 2. wrong password
    const form = page.getByTestId('sign-in-form');
    await form.getByLabel('Email').fill('reader@example.com');
    await form.getByLabel('Password').fill('wrong');
    await form.getByRole('button', { name: 'Sign in' }).click();
    check('a wrong password shows Supabase\'s message', await page.getByText('Invalid login credentials').waitFor({ timeout: 8000 }).then(() => true, () => false));

    // 3. email sign-in → profile
    state.profile = { id: USER_ID, display_name: 'Reader One', avatar_url: null, created_at: '2026-10-25T10:00:00Z', updated_at: '2026-10-25T10:00:00Z' };
    await form.getByLabel('Password').fill('correct-horse');
    await form.getByRole('button', { name: 'Sign in' }).click();
    check('email sign-in closes the dialog', await page.getByTestId('sign-in-dialog').waitFor({ state: 'detached', timeout: 8000 }).then(() => true, () => false));
    await page.getByTestId('account-button').click();
    check('signed-in menu offers Profile, My scans and Sign out', (await visible('menu-profile')) && (await visible('menu-scans')) && (await visible('menu-sign-out')));
    await page.getByTestId('menu-profile').click();
    check('Profile shows the account panel', await visible('account-panel'));
    check('the profile row is shown', (await page.getByTestId('profile-name').textContent()) === 'Reader One');
    const read = lastCall('/rest/v1/profiles', 'GET');
    check('profile is read with the user\'s token and only their id', !!read && read.headers.authorization?.startsWith('Bearer ey') && read.query.includes(`id=eq.${USER_ID}`), JSON.stringify(read?.query));
    check('header shows the signed-in user', ((await page.getByTestId('account-button').getAttribute('aria-label')) ?? '').includes('Reader One'));

    // 4. edit the display name
    await page.getByTestId('profile-form').getByLabel('Display name').fill('Reader Prime');
    await page.getByTestId('profile-form').getByRole('button', { name: 'Save changes' }).click();
    check('saving shows Saved', await page.getByText('Saved.').waitFor({ timeout: 8000 }).then(() => true, () => false));
    const patch = lastCall('/rest/v1/profiles', 'PATCH');
    check('update sends only display_name, scoped to the user', !!patch && JSON.stringify(patch.body) === '{"display_name":"Reader Prime"}' && patch.query.includes(`id=eq.${USER_ID}`), JSON.stringify(patch));
    check('header picks up the new name', ((await page.getByTestId('account-button').getAttribute('aria-label')) ?? '').includes('Reader Prime'));

    // 4b. My scans: listed from Supabase with the user's token, and reopened as an analysis link
    state.scans = [{ id: '0b8c7a52-5d0e-4a8e-9a43-2f3c2f7f9a10', user_id: USER_ID, aoi_id: 'rondonia-frontier', name: 'Rondônia frontier', baseline: 2019, comparison: 2025,
      summary: { status: 'READY', net_change_ha: -1234.5, event_count: 12 }, bbox: null, created_at: '2026-11-17T10:00:00Z' }];
    await page.getByTestId('account-button').click();
    await page.getByTestId('menu-scans').click();
    check('My scans opens #/scans and lists the saved scan', (await visible('saved-scan')) && hash() === '#/scans', hash());
    check('the saved figures are shown', await page.getByTestId('saved-scan').getByText('−1,235 ha').isVisible());
    const list = lastCall('/rest/v1/saved_scans', 'GET');
    check("scans are read with the user's token", !!list && list.headers.authorization?.startsWith('Bearer ey'));
    await page.getByTestId('reopen-scan').click();
    check('Open reopens the analysis with its window', await page.waitForURL((u) => u.hash.startsWith('#/analysis/rondonia-frontier?from=2019&to=2025'), { timeout: 8000 }).then(() => true, () => false), hash());
    await page.goto(`${BASE}#/profile`, { waitUntil: 'domcontentloaded' });
    await visible('account-panel');

    // 5. reload keeps the session
    await page.reload({ waitUntil: 'domcontentloaded' });
    check('a reload keeps the session and the page', (await visible('account-panel')) && hash() === '#/profile');

    // 6. sign out
    await page.getByTestId('sign-out').click();
    check('sign out calls Supabase and closes the page', await page.getByTestId('profile-page').waitFor({ state: 'detached', timeout: 8000 }).then(() => !!lastCall('/logout'), () => false));
    await page.getByTestId('account-button').click();
    check('after sign out the menu offers Sign in again', await visible('menu-sign-in'));
    await page.getByTestId('menu-sign-in').click();

    // 7. sign up
    await page.getByRole('button', { name: 'Create an account' }).click();
    const up = page.getByTestId('sign-up-form');
    await up.getByLabel('Name (optional)').fill('New Person');
    await up.getByLabel('Email').fill('new@example.com');
    await up.getByLabel('Password').fill('long-enough-pw');
    await up.getByRole('button', { name: 'Create account' }).click();
    check('sign-up asks to confirm the email', await page.getByText('We sent a confirmation link to new@example.com').waitFor({ timeout: 8000 }).then(() => true, () => false));
    const signup = lastCall('/signup');
    check('sign-up sends the name and a PKCE challenge', signup?.body?.data?.full_name === 'New Person' && !!signup?.body?.code_challenge, JSON.stringify(signup?.body));

    // 8. password reset → link → new password
    await page.getByRole('button', { name: 'Back to sign in' }).click();
    await page.getByRole('button', { name: 'Forgot password?' }).click();
    await page.getByTestId('reset-form').getByLabel('Email').fill('reader@example.com');
    await page.getByTestId('reset-form').getByRole('button', { name: 'Send reset link' }).click();
    check('reset shows the link-sent notice', await page.getByText('a reset link is on its way').waitFor({ timeout: 8000 }).then(() => true, () => false));
    const recover = lastCall('/recover');
    const resetBack = new URL(new URL(`http://x${recover.query}`).searchParams.get('redirect_to') ?? recover.body?.redirect_to ?? BASE);
    resetBack.searchParams.set('code', 'reset-code');
    await page.goto(resetBack.toString(), { waitUntil: 'domcontentloaded' });
    check('the reset link opens "Choose a new password"', await visible('recovery-form'));
    await page.getByLabel('New password', { exact: true }).fill('another-long-pw');
    await page.getByLabel('Repeat new password').fill('another-long-pw');
    await page.getByRole('button', { name: 'Save new password' }).click();
    check('saving the new password calls Supabase and shows the profile', (await visible('account-panel')) && lastCall('/user', 'PUT')?.body?.password === 'another-long-pw');
    check('the ?code= is removed from the address bar', !new URL(page.url()).searchParams.has('code'), page.url());
    await page.getByTestId('sign-out').click();
    await page.getByTestId('profile-page').waitFor({ state: 'detached', timeout: 8000 });

    // 9. Google
    state.profile = { id: USER_ID, display_name: 'Asha Verma', avatar_url: 'https://lh3.googleusercontent.com/a/test', created_at: '2026-10-25T10:00:00Z', updated_at: '2026-10-25T10:00:00Z' };
    await page.goto(`${BASE}#/profile`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('google-sign-in').click();
    check('Google sign-in round trip ends signed in', await page.getByTestId('account-button').and(page.locator('[aria-label*="Asha Verma"]')).waitFor({ timeout: 10000 }).then(() => true, () => false));
    const authorize = lastCall('/authorize');
    const q = new URLSearchParams(authorize?.query ?? '');
    check('Google is asked with PKCE and the app\'s own return URL', q.get('provider') === 'google' && q.get('code_challenge_method') === 's256' && (q.get('redirect_to') ?? '').startsWith(BASE.replace(/\/$/, '')), authorize?.query);
    check('the Google ?code= is removed from the address bar', !new URL(page.url()).searchParams.has('code'), page.url());
    await page.getByTestId('account-button').click();
    await page.getByTestId('menu-sign-out').click();
    await page.getByTestId('account-button').and(page.locator('[aria-label="Account menu"]')).waitFor({ timeout: 8000 });

    // 10. a cancelled Google sign-in comes back with an error
    await page.goto(`${BASE}?error=access_denied&error_code=access_denied&error_description=Sign-in+was+cancelled`, { waitUntil: 'domcontentloaded' });
    check('a returned error is shown on the profile page', await page.getByTestId('profile-page').getByText('Sign-in was cancelled').waitFor({ timeout: 8000 }).then(() => true, () => false));
    check('…and removed from the address bar', !new URL(page.url()).search.includes('error'), page.url());

    // 11. phone: the menu reaches the account page
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}#/`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByTestId('menu-account').click();
    check('phone menu opens the sign-in page', (await visible('sign-in-form')) && hash() === '#/profile');
    check('the earlier returned error is not shown again', (await page.getByText('Sign-in was cancelled').count()) === 0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check('no horizontal scroll at 390 px', overflow <= 0, String(overflow));
  }
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (e) {
  check('test ran to completion', false, e.message);
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
