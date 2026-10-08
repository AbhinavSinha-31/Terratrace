/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the TERRATRACE API: default /api (proxied to :8001 in dev); in production the backend's public URL
   *  ending in /api, e.g. https://api.example.com/api. Baked into the public bundle — never put credentials in VITE_ variables. */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}