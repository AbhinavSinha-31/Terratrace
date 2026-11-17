import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
// The anon / publishable key (both names accepted). Never the service_role key: that one bypasses Row Level Security.
const key = (import.meta.env.VITE_SUPABASE_ANON_KEY || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY)?.trim();

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

/** Accounts, saved scans and the community. null when the build has no Supabase settings: sign-in then shows as unavailable. */
export const supabase = create();

/** Where Google and the email links return to. Must be listed under Auth → URL Configuration → Redirect URLs. */
export const authRedirectUrl = () => `${window.location.origin}${window.location.pathname}`;

/** "Continue with Google" is shown only when the build sets VITE_AUTH_GOOGLE=true (after the provider is set up). */
export const GOOGLE_ENABLED = import.meta.env.VITE_AUTH_GOOGLE === 'true';
