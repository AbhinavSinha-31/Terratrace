/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the TERRATRACE API: default /api (proxied to :8001 in dev); in production the backend's public URL
   *  ending in /api, e.g. https://api.example.com/api. Baked into the public bundle — never put credentials in VITE_ variables. */
  readonly VITE_API_BASE?: string;
  /** Supabase project URL (accounts only), e.g. https://abcd1234.supabase.co. Public by design. */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase publishable key (sb_publishable_…) or legacy anon key. Public by design: Row Level Security protects
   *  the data. Never the secret / service_role key. */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}