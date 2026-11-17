import { useEffect } from 'react';
import { create } from 'zustand';
import type { Session } from '@supabase/supabase-js';
import { authRedirectUrl, supabase } from '../lib/supabase';
import { useUi } from './store';

export type AuthStatus = 'unconfigured' | 'loading' | 'signed-out' | 'signed-in';

interface AuthState {
  status: AuthStatus;
  session: Session | null;
  /** Arrived through a password-reset link: the profile page asks for a new password first. */
  recovery: boolean;
  /** An error that Google or an email link sent back to the app; shown once on the profile page. */
  callbackError: string | null;
  clearCallbackError(): void;
  /** The sign-in dialog (opened from the avatar, or by an action that needs an account). */
  signInOpen: boolean;
  /** Why the dialog opened ("Sign in to save this scan."); shown above the form. */
  signInReason: string | null;
}

export const useAuth = create<AuthState>((set) => ({
  status: supabase ? 'loading' : 'unconfigured',
  session: null,
  recovery: false,
  callbackError: null,
  clearCallbackError: () => set({ callbackError: null }),
  signInOpen: false,
  signInReason: null,
}));

export const openSignIn = (reason: string | null = null) => useAuth.setState({ signInOpen: true, signInReason: reason });
export const closeSignIn = () => useAuth.setState({ signInOpen: false, signInReason: null });

/** For actions that need an account: true when signed in; otherwise opens the sign-in dialog and returns false. */
export function requireSignIn(reason: string): boolean {
  if (useAuth.getState().status === 'signed-in') return true;
  openSignIn(reason);
  return false;
}

/** The signed-in user's id, or null. */
export const currentUserId = () => useAuth.getState().session?.user.id ?? null;

function auth() {
  if (!supabase) throw new Error('Sign-in is not configured for this build.');
  return supabase.auth;
}

export async function signInWithGoogle(): Promise<void> {
  const { error } = await auth().signInWithOAuth({ provider: 'google', options: { redirectTo: authRedirectUrl() } });
  if (error) throw error;
}

export async function signInWithEmail(email: string, password: string): Promise<void> {
  const { error } = await auth().signInWithPassword({ email, password });
  if (error) throw error;
}

/** Returns true when Supabase requires the address to be confirmed first (no session yet). */
export async function signUpWithEmail(email: string, password: string, fullName: string): Promise<boolean> {
  const { data, error } = await auth().signUp({
    email,
    password,
    options: { emailRedirectTo: authRedirectUrl(), data: fullName ? { full_name: fullName } : undefined },
  });
  if (error) throw error;
  return !data.session;
}

/** Passwordless: emails a one-time sign-in link (creates the account on first use). */
export async function signInWithMagicLink(email: string): Promise<void> {
  const { error } = await auth().signInWithOtp({ email, options: { emailRedirectTo: authRedirectUrl(), shouldCreateUser: true } });
  if (error) throw error;
}

export async function sendPasswordReset(email: string): Promise<void> {
  const { error } = await auth().resetPasswordForEmail(email, { redirectTo: authRedirectUrl() });
  if (error) throw error;
}

export async function setNewPassword(password: string): Promise<void> {
  const { error } = await auth().updateUser({ password });
  if (error) throw error;
  useAuth.setState({ recovery: false });
}

export async function signOut(): Promise<void> {
  const { error } = await auth().signOut();
  if (error) throw error;
}

/** ?error=…&error_description=… (or the same in the hash) from a cancelled Google sign-in or an expired email link. */
function takeCallbackError(): string | null {
  const url = new URL(window.location.href);
  const hash = url.hash.startsWith('#error') ? new URLSearchParams(url.hash.slice(1)) : null;
  const message = url.searchParams.get('error_description') ?? url.searchParams.get('error')
    ?? hash?.get('error_description') ?? hash?.get('error') ?? null;
  if (!message) return null;
  for (const k of ['error', 'error_code', 'error_description']) url.searchParams.delete(k);
  if (hash) url.hash = '#/';
  window.history.replaceState(window.history.state, '', url.toString());
  return message;
}

/** Mirror the Supabase session into useAuth for the life of the app. */
export function useAuthSync() {
  useEffect(() => {
    if (!supabase) return;
    const callbackError = takeCallbackError();
    if (callbackError) {
      useAuth.setState({ callbackError });
      useUi.getState().openProfile();
    }
    // No awaited Supabase calls inside this callback (supabase-js holds a lock while it runs).
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      useAuth.setState({ session, status: session ? 'signed-in' : 'signed-out', ...(session ? { signInOpen: false, signInReason: null } : {}) });
      if (event === 'PASSWORD_RECOVERY') {
        useAuth.setState({ recovery: true });
        useUi.getState().openProfile();
      }
    });
    return () => data.subscription.unsubscribe();
  }, []);
}
