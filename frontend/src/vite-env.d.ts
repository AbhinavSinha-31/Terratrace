/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the TERRATRACE API (default /api, proxied to :8001 in dev). Never put credentials in VITE_ variables. */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}