/** Release version of this build, e.g. "1.2.0"; "dev" for local and untagged builds. */
export const APP_VERSION: string = __APP_VERSION__;

/** Full git commit hash of this build, or null when unknown. */
export const GIT_SHA: string | null = __GIT_SHA__;

/** Short commit hash (7 characters), or null when unknown. */
export const GIT_SHA_SHORT: string | null = GIT_SHA ? GIT_SHA.slice(0, 7) : null;

/**
 * Formats the build for display, e.g. "1.2.0 (abc1234)" or "dev".
 */
export function formatVersion(): string {
  return GIT_SHA_SHORT ? `${APP_VERSION} (${GIT_SHA_SHORT})` : APP_VERSION;
}
