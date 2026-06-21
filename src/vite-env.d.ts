/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" builds the static-read SPA (reads the pre-rendered snapshot, not a live
   *  backend) for the serverless deploy. Unset/anything else = live backend. */
  readonly VITE_STATIC_READS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
