/**
 * Heading anchors as Joplin writes them in links like ":/<noteId>#<slug>" (uslug style: lower case,
 * letters, digits, "-" and "_" kept, whitespace becomes "-", everything else dropped). Repeated
 * headings get "-1", "-2", … like markdown-it-anchor.
 */

/**
 * Turns heading text into a slug. Runs of "-" are collapsed so small differences in how
 * whitespace was slugged still match.
 */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}\p{M}_-]/gu, "")
    .replace(/-+/g, "-");
}

/** Decodes a URL fragment ("#Caf%C3%A9" or "Café") into a slug; null when it is empty. */
export function fragmentSlug(fragment: string): string | null {
  let text = fragment.replace(/^#/, "");
  try {
    text = decodeURIComponent(text);
  } catch {
    // keep the raw text
  }
  const slug = headingSlug(text);
  return slug || null;
}

/**
 * Finds the heading a slug points to: the first heading with that slug, or for "<slug>-<n>" the
 * (n+1)-th heading with "<slug>".
 */
export function findHeading<T>(headings: { slug: string; item: T }[], slug: string): T | null {
  const exact = headings.find((h) => h.slug === slug);
  if (exact) return exact.item;
  const numbered = /^(.*)-(\d+)$/.exec(slug);
  if (!numbered) return null;
  const same = headings.filter((h) => h.slug === numbered[1]);
  return same[Number(numbered[2])]?.item ?? null;
}
