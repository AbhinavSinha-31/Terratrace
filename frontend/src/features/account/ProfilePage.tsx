import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, KeyRound, LogOut, Mail, TriangleAlert, CheckCircle2, Sparkles } from 'lucide-react';
import { Button, Skeleton, StateView } from '../../design';
import { useUi } from '../../state/store';
import { sendPasswordReset, setNewPassword, signInWithEmail, signInWithGoogle, signInWithMagicLink, signOut, signUpWithEmail, useAuth } from '../../state/auth';
import { GOOGLE_ENABLED } from '../../lib/supabase';
import { identity, useProfile, useUpdateProfile } from './profile';

const message = (e: unknown) => (e instanceof Error && e.message ? e.message : 'Something went wrong. Try again.');

/** A user's photo, or their initial when there is none (or it fails to load). */
export function UserAvatar({ name, src, size = 36 }: { name: string; src: string | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  if (src && !broken) {
    // Google photos refuse requests that carry a referrer.
    return <img src={src} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} style={style} className="shrink-0 rounded-full object-cover" />;
  }
  return (
    <span aria-hidden style={style} className="grid shrink-0 place-items-center rounded-full bg-accent/15 font-semibold uppercase text-accent shadow-[0_0_0_1px_rgba(69,208,196,0.4)]">
      {name.trim().charAt(0) || '?'}
    </span>
  );
}

export function Notice({ tone, children }: { tone: 'error' | 'info'; children: ReactNode }) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`flex items-start gap-2 rounded-md px-3 py-2.5 text-[12px] leading-relaxed ${tone === 'error' ? 'bg-bad/10 text-[#ff8a80] shadow-[0_0_0_1px_rgba(229,88,79,0.4)]' : 'bg-accent/10 text-ink-2 shadow-[0_0_0_1px_rgba(69,208,196,0.35)]'}`}>
      <span className="mt-px shrink-0">{tone === 'error' ? <TriangleAlert size={14} /> : <CheckCircle2 size={14} className="text-accent" />}</span>
      <span>{children}</span>
    </div>
  );
}

export function Field({ label, ...input }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11.5px] font-medium text-ink-3">{label}</span>
      <input {...input} className="h-10 w-full rounded-md bg-white/[0.04] px-3 text-[13px] text-ink shadow-[0_0_0_1px_rgba(255,255,255,0.12)] outline-none placeholder:text-ink-4 focus:shadow-[0_0_0_1px_rgba(69,208,196,0.7)] disabled:opacity-50" />
    </label>
  );
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

type Mode = 'sign-in' | 'sign-up' | 'magic' | 'reset';

/** Sign in / sign up / magic link / password reset. Used by the sign-in dialog and by #/profile when signed out. */
export function SignInPanel({ titleId = 'profile-title', reason }: { titleId?: string; reason?: string | null }) {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const callbackError = useAuth((s) => s.callbackError);
  const clearCallbackError = useAuth((s) => s.clearCallbackError);

  const run = async (task: () => Promise<string | null | void>) => {
    setBusy(true); setError(null); setInfo(null); clearCallbackError();
    try {
      const done = await task();
      if (done) setInfo(done);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const switchTo = (m: Mode) => { setMode(m); setError(null); setInfo(null); };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const addr = email.trim();
    if (mode === 'sign-in') void run(() => signInWithEmail(addr, password));
    else if (mode === 'sign-up') {
      void run(async () => ((await signUpWithEmail(addr, password, name.trim()))
        ? `We sent a confirmation link to ${addr}. Open it in this browser to finish creating your account.`
        : null));
    } else if (mode === 'magic') {
      void run(async () => { await signInWithMagicLink(addr); return `We emailed a sign-in link to ${addr}. Open it in this browser to finish signing in.`; });
    } else void run(async () => { await sendPasswordReset(addr); return `If ${addr} has an account, a reset link is on its way. Open it in this browser.`; });
  };

  const title = mode === 'sign-in' ? 'Sign in to TERRATRACE' : mode === 'sign-up' ? 'Create your account' : mode === 'magic' ? 'Sign in with an email link' : 'Reset your password';
  const intro = mode === 'reset' ? 'Enter your email and we will send you a link to choose a new password.'
    : mode === 'magic' ? 'No password needed: we email you a one-time link. New addresses get an account automatically.'
    : 'An account lets you save scans and join the community. Exploring and analysing areas works without one.';
  return (
    <div className="space-y-5">
      <div>
        <h1 id={titleId} className="t-h1 text-ink">{title}</h1>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-3">{intro}</p>
      </div>
      {reason && <Notice tone="info">{reason}</Notice>}
      {callbackError && <Notice tone="error">{callbackError}</Notice>}
      {GOOGLE_ENABLED && (mode === 'sign-in' || mode === 'sign-up') && (
        <>
          <Button block size="lg" variant="primary" icon={<GoogleMark />} disabled={busy} onClick={() => void run(signInWithGoogle)} data-testid="google-sign-in">
            Continue with Google
          </Button>
          <div className="flex items-center gap-3 text-[11px] uppercase tracking-wider text-ink-4"><span className="h-px flex-1 bg-line" />or with email<span className="h-px flex-1 bg-line" /></div>
        </>
      )}
      <form onSubmit={submit} className="space-y-3" data-testid={`${mode}-form`}>
        {mode === 'sign-up' && <Field label="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="name" disabled={busy} />}
        <Field label="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" disabled={busy} />
        {(mode === 'sign-in' || mode === 'sign-up') && (
          <Field label="Password" type="password" required minLength={mode === 'sign-up' ? 8 : undefined} value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'} disabled={busy} placeholder={mode === 'sign-up' ? 'At least 8 characters' : undefined} />
        )}
        {error && <Notice tone="error">{error}</Notice>}
        {info && <Notice tone="info">{info}</Notice>}
        <Button type="submit" block size="lg" variant="brand" icon={mode === 'reset' || mode === 'magic' ? <Mail size={15} /> : undefined} disabled={busy}>
          {busy ? 'Please wait…' : mode === 'sign-in' ? 'Sign in' : mode === 'sign-up' ? 'Create account' : mode === 'magic' ? 'Email me a sign-in link' : 'Send reset link'}
        </Button>
      </form>
      <div className="flex flex-wrap justify-between gap-2 text-[12px]">
        {mode === 'sign-in' ? (
          <>
            <button className="text-accent hover:underline" onClick={() => switchTo('sign-up')}>Create an account</button>
            <button className="flex items-center gap-1 text-ink-2 hover:text-ink" onClick={() => switchTo('magic')} data-testid="magic-link-mode"><Sparkles size={12} /> Email me a link instead</button>
            <button className="text-ink-3 hover:text-ink" onClick={() => switchTo('reset')}>Forgot password?</button>
          </>
        ) : (
          <button className="text-accent hover:underline" onClick={() => switchTo('sign-in')}>Back to sign in</button>
        )}
      </div>
    </div>
  );
}

function RecoveryPanel() {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError('The two passwords do not match.');
    setBusy(true); setError(null);
    try { await setNewPassword(password); } catch (err) { setError(message(err)); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="space-y-4" data-testid="recovery-form">
      <div>
        <h1 id="profile-title" className="t-h1 text-ink">Choose a new password</h1>
        <p className="mt-1.5 text-[12.5px] text-ink-3">You opened a password-reset link. Set a new password to continue.</p>
      </div>
      <Field label="New password" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" disabled={busy} />
      <Field label="Repeat new password" type="password" required minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" disabled={busy} />
      {error && <Notice tone="error">{error}</Notice>}
      <Button type="submit" block size="lg" variant="brand" icon={<KeyRound size={15} />} disabled={busy}>{busy ? 'Saving…' : 'Save new password'}</Button>
    </form>
  );
}

function AccountPanel() {
  const user = useAuth((s) => s.session!.user);
  const close = useUi((s) => s.closeProfile);
  const { data: profile, isLoading, isError, refetch } = useProfile();
  const update = useUpdateProfile();
  const who = identity(user, profile);
  const [draft, setDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const name = draft ?? profile?.display_name ?? '';
  const providers: string[] = user.app_metadata?.providers ?? (user.app_metadata?.provider ? [user.app_metadata.provider] : []);

  const save = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    update.mutate({ display_name: name.trim() || null }, { onSuccess: () => { setDraft(null); setSaved(true); } });
  };
  const leave = async () => {
    setLeaving(true); setSignOutError(null);
    try { await signOut(); close(); } catch (e) { setSignOutError(message(e)); } finally { setLeaving(false); }
  };

  return (
    <div className="space-y-6" data-testid="account-panel">
      <div className="flex items-center gap-4">
        <UserAvatar name={who.name} src={who.avatar} size={64} />
        <div className="min-w-0">
          <h1 id="profile-title" className="t-h1 truncate text-ink" data-testid="profile-name">{who.name}</h1>
          {who.email && <p className="truncate text-[12.5px] text-ink-3">{who.email}</p>}
        </div>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-md px-4 py-3 text-[12.5px] shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
        <dt className="text-ink-3">Signed in with</dt>
        <dd className="text-ink">{providers.length ? providers.map((p) => (p === 'email' ? 'Email' : p === 'google' ? 'Google' : p)).join(', ') : '—'}</dd>
        <dt className="text-ink-3">Member since</dt>
        <dd className="t-data text-ink">{(profile?.created_at ?? user.created_at)?.slice(0, 10) ?? '—'}</dd>
      </dl>

      {isLoading ? (
        <Skeleton className="h-24 rounded-md" />
      ) : isError ? (
        <div className="tt-panel"><StateView kind="error" title="Profile unavailable" onRetry={() => refetch()} compact>Your profile could not be loaded.</StateView></div>
      ) : profile === null ? (
        <Notice tone="error">No profile row exists for this account. The profiles migration may not have been applied to this Supabase project.</Notice>
      ) : (
        <form onSubmit={save} className="space-y-3" data-testid="profile-form">
          <Field label="Display name" value={name} maxLength={80} onChange={(e) => { setDraft(e.target.value); setSaved(false); }} disabled={update.isPending} />
          {update.isError && <Notice tone="error">{message(update.error)}</Notice>}
          {saved && <Notice tone="info">Saved.</Notice>}
          <Button type="submit" variant="brand" disabled={update.isPending || draft === null || name.trim() === (profile?.display_name ?? '')}>
            {update.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </form>
      )}

      <div className="border-t border-line pt-5">
        {signOutError && <div className="mb-3"><Notice tone="error">{signOutError}</Notice></div>}
        <Button variant="secondary" icon={<LogOut size={15} />} onClick={() => void leave()} disabled={leaving} data-testid="sign-out">
          {leaving ? 'Signing out…' : 'Sign out'}
        </Button>
      </div>
    </div>
  );
}

/** #/profile — sign in, or see and edit your profile. Full page over the map, like a case study. */
export function ProfilePage() {
  const open = useUi((s) => s.profileOpen);
  const close = useUi((s) => s.closeProfile);
  const status = useAuth((s) => s.status);
  const recovery = useAuth((s) => s.recovery);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) {
      useAuth.getState().clearCallbackError(); // a returned sign-in error is shown once, not every time the page reopens
      return;
    }
    scroller.current?.scrollTo({ top: 0 });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div ref={scroller} role="dialog" aria-modal="true" aria-labelledby="profile-title" data-testid="profile-page"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
          className="absolute inset-0 z-40 overflow-y-auto bg-base">
          <div className="mx-auto w-full max-w-[440px] px-4 pb-16 pt-20 sm:px-6">
            <button onClick={close} className="tt-press mb-6 flex items-center gap-1.5 text-[12.5px] text-ink-3 hover:text-ink"><ArrowLeft size={15} /> Back</button>
            {status === 'unconfigured' ? (
              <div className="tt-panel">
                <StateView kind="empty" title="Accounts are not available yet">
                  <span id="profile-title">Sign-in is not switched on for this version of TERRATRACE. Exploring and analysing areas works without an account.</span>
                </StateView>
              </div>
            ) : status === 'loading' ? (
              <div className="space-y-4" aria-busy="true" aria-label="Checking your session"><Skeleton className="h-8 w-2/3 rounded-md" /><Skeleton className="h-40 rounded-md" /></div>
            ) : recovery && status === 'signed-in' ? (
              <RecoveryPanel />
            ) : status === 'signed-in' ? (
              <AccountPanel />
            ) : (
              <SignInPanel />
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
