/**
 * Reads a boolean query flag the way the API has always accepted it: only "true" and "1" count.
 */
export function isTrueFlag(value: unknown): boolean {
  return value === 'true' || value === '1';
}
