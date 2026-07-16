/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Google OAuth client secret for the Drive backend, injected at build time.
   * Set in a gitignored .env for official builds; empty for source builds (which
   * then need their own OAuth client). See src/lib/backends/gdrive-oauth.ts.
   */
  readonly VITE_GOOGLE_CLIENT_SECRET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
