/// <reference types="vite/client" />

/** Release version, replaced at build time by Vite's define (see vite.config.ts) */
declare const __APP_VERSION__: string;
/** Git commit of the build, or null when unknown */
declare const __GIT_SHA__: string | null;
