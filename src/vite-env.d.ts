/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Google OAuth client secret for the Drive backend, injected at build time.
   * Set in a gitignored .env for official builds; empty for source builds (which
   * then need their own OAuth client). See src/lib/backends/gdrive-oauth.ts.
   */
  readonly VITE_GOOGLE_CLIENT_SECRET?: string;
  /**
   * A Dropbox app key to use instead of Konode's own (src/lib/backends/dropbox-oauth.ts),
   * for a fork with its own Dropbox app. Not a secret; unset in official builds.
   */
  readonly VITE_DROPBOX_APP_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
