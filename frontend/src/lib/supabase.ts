import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();

function create(): SupabaseClient | null {
  if (!url || !key) return null;
  try {
    // PKCE: Google and the email links return with ?code=… in the query, so the hash router (#/…) is never touched.
    return createClient(url, key, { auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  } catch (e) {
    console.warn('TERRATRACE: Supabase settings are invalid; sign-in is disabled', e);
    return null;
  }
}

/** Accounts (sign-in and profiles) only. null when the build has no Supabase settings: sign-in then shows as unavailable. */
export const supabase = create();

/** Where Google and the email links return to. Must be listed under Auth → URL Configuration → Redirect URLs. */
export const authRedirectUrl = () => `${window.location.origin}${window.location.pathname}`;
