import { headingSlug } from "./heading-slug";

export interface HeadingOutlineItem {
  level: number;
  text: string;
  slug: string;
}

function cleanHeadingInlineMarkdown(raw: string): string {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__|\*|_|~~|==|\+\+|\^|~)/g, "")
    .replace(/\\([\\`*_{}[\]()#+\-.!~^])/g, "$1")
    .replace(/\s+#+\s*$/, "")
    .trim();
}

/**
 * Extracts ATX headings outside fenced code blocks with unique Joplin-compatible anchor slugs.
 */
export function extractHeadings(markdown: string): HeadingOutlineItem[] {
  if (!markdown) return [];
  const lines = markdown.split(/\r?\n/);
  const items: HeadingOutlineItem[] = [];
  const counts = new Map<string, number>();
  let fence: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const fenceMatch = /^(```+|~~~+)/.exec(trimmed);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence) continue;

    const match = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (!match) continue;
    const text = cleanHeadingInlineMarkdown(match[2]);
    if (!text) continue;
    const base = headingSlug(text) || "heading";
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    const slug = seen === 0 ? base : `${base}-${seen}`;
    items.push({ level: match[1].length, text, slug });
  }
  return items;
}

/** Computes word count, character count and estimated reading time in minutes. */
export function computeNoteStats(text: string, isHtml = false): {
  words: number;
  characters: number;
  readingMinutes: number;
} {
  const plain = isHtml
    ? text.replace(/<[^>]+>/g, " ").replace(/&[a-z0-9#]+;/gi, " ")
    : text
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`[^`]*`/g, " ")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1 ")
        .replace(/[#>*_~=`[\]()-]/g, " ");
  const normalized = plain.trim();
  const words = normalized ? normalized.split(/\s+/).length : 0;
  const characters = normalized.replace(/\s+/g, "").length;
  const readingMinutes = words > 0 ? Math.max(1, Math.ceil(words / 225)) : 0;
  return { words, characters, readingMinutes };
}

/** Converts Joplin :/id image & item links to web URLs before TipTap WYSIWYG editing. */
export function joplinToRichMarkdown(markdown: string): string {
  if (!markdown) return "";
  let out = markdown.replace(
    /!\[([^\]]*)\]\(:\/?([0-9a-fA-F]{32})(\s+"[^"]*")?\)/g,
    (_, alt, id, title = "") => `![${alt}](/api/resources/${id.toLowerCase()}${title})`
  );
  out = out.replace(
    /(^|[^!])\[([^\]]*)\]\(:\/?([0-9a-fA-F]{32})(#[^\s()"'<>]*)?(\s+"[^"]*")?\)/g,
    (_, before, text, id, fragment = "", title = "") =>
      `${before}[${text}](/joplin-item/${id.toLowerCase()}${fragment}${title})`
  );
  return out;
}

/** Converts /api/resources/<id> and /joplin-item/<id> back to Joplin :/id after TipTap editing. */
export function richMarkdownToJoplin(markdown: string): string {
  if (!markdown) return "";
  let out = markdown.replace(
    /!\[([^\]]*)\]\((?:https?:\/\/[^/\s)]+)?\/api\/resources\/([0-9a-fA-F]{32})(\s+"[^"]*")?\)/g,
    (_, alt, id, title = "") => `![${alt}](:/${id.toLowerCase()}${title})`
  );
  out = out.replace(
    /(^|[^!])\[([^\]]*)\]\((?:https?:\/\/[^/\s)]+)?\/joplin-item\/([0-9a-fA-F]{32})(#[^\s()"'<>]*)?(\s+"[^"]*")?\)/g,
    (_, before, text, id, fragment = "", title = "") =>
      `${before}[${text}](:/${id.toLowerCase()}${fragment}${title})`
  );
  return out;
}

/** Converts Joplin :/id img & link tags in HTML notes to web URLs before TipTap WYSIWYG editing. */
export function joplinToRichHtml(html: string): string {
  if (!html) return "";
  let out = html.replace(
    /<img([^>]*?)\ssrc=(["']):\/?([0-9a-fA-F]{32})\2([^>]*)>/gi,
    (_, before, _quote, id, after) => `<img${before} src="/api/resources/${id.toLowerCase()}"${after}>`
  );
  out = out.replace(
    /<a([^>]*?)\shref=(["']):\/?([0-9a-fA-F]{32})(#[^"'<>\s]*)?\2([^>]*)>/gi,
    (_, before, _quote, id, fragment = "", after) =>
      `<a${before} href="/joplin-item/${id.toLowerCase()}${fragment}"${after}>`
  );
  return out;
}

/** Converts /api/resources/<id> and /joplin-item/<id> HTML attributes back to Joplin :/id after TipTap editing. */
export function richHtmlToJoplin(html: string): string {
  if (!html) return "";
  let out = html.replace(
    /<img([^>]*?)\ssrc=(["'])(?:https?:\/\/[^/"']+)?\/api\/resources\/([0-9a-fA-F]{32})\2([^>]*)>/gi,
    (_, before, quote, id, after) => `<img${before} src=${quote}:/${id.toLowerCase()}${quote}${after}>`
  );
  out = out.replace(
    /<a([^>]*?)\shref=(["'])(?:https?:\/\/[^/"']+)?\/joplin-item\/([0-9a-fA-F]{32})(#[^"'<>\s]*)?\2([^>]*)>/gi,
    (_, before, quote, id, fragment = "", after) =>
      `<a${before} href=${quote}:/${id.toLowerCase()}${fragment}${quote}${after}>`
  );
  return out;
}
