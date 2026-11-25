import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { WriteValidationError } from './note-writer.js';

export interface DnsAddress {
  address: string;
  family: number;
}

export type DnsLookupFn = (hostname: string) => Promise<DnsAddress[]>;

export type FetchRemoteFn = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal }
) => Promise<Response>;

const defaultDnsLookup: DnsLookupFn = (hostname) => lookup(hostname, { all: true });
const defaultFetchRemote: FetchRemoteFn = (url, init) =>
  fetch(url, { ...init, redirect: 'manual' });

const MAX_CLIP_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 15_000;
export const MAX_CLIP_IMAGES = 50;
const IMAGE_DOWNLOAD_CONCURRENCY = 4;

export interface UploadedClipImage {
  id: string;
}

export type UploadClipImageFn = (image: {
  name: string;
  mime: string;
  data: Buffer;
}) => Promise<UploadedClipImage>;

const BLOCKED_HOSTNAMES = new Set(['localhost', 'ip6-localhost', 'ip6-loopback']);

function isPublicIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 0) return false; // 0.0.0.0/8 current network
  if (a === 10) return false; // 10.0.0.0/8 RFC1918
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10 CGNAT
  if (a === 127) return false; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return false; // 169.254.0.0/16 link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 0 && parts[2] === 0) return false; // 192.0.0.0/24 IETF
  if (a === 192 && b === 0 && parts[2] === 2) return false; // TEST-NET-1
  if (a === 192 && b === 168) return false; // 192.168.0.0/16 RFC1918
  if (a === 198 && (b === 18 || b === 19)) return false; // 198.18.0.0/15 benchmark
  if (a === 198 && b === 51 && parts[2] === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && parts[2] === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast & reserved
  return true;
}

export function isPublicIp(rawIp: string): boolean {
  const ip = rawIp.split('%')[0].toLowerCase();
  const v = net.isIP(ip);
  if (v === 4) return isPublicIpv4(ip);
  if (v !== 6) return false;

  if (ip === '::' || ip === '::1') return false;
  const v4MappedDotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (v4MappedDotted) return isPublicIpv4(v4MappedDotted[1]);
  const v4MappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (v4MappedHex) {
    const hi = parseInt(v4MappedHex[1], 16);
    const lo = parseInt(v4MappedHex[2], 16);
    const v4 = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
    return isPublicIpv4(v4);
  }
  if (ip.startsWith('fc') || ip.startsWith('fd')) return false; // unique local fc00::/7
  if (/^fe[89ab]/.test(ip)) return false; // link-local fe80::/10
  if (ip.startsWith('ff')) return false; // multicast
  if (ip.startsWith('2001:db8:')) return false; // documentation
  return true;
}

export async function assertSafeRemoteUrl(
  rawUrl: string,
  dnsLookup: DnsLookupFn = defaultDnsLookup
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new WriteValidationError('Invalid URL', 400);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WriteValidationError('Only http:// and https:// URLs are supported', 400);
  }
  if (url.username || url.password) {
    throw new WriteValidationError('URLs with embedded credentials are not allowed', 400);
  }

  const host = url.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (!host) throw new WriteValidationError('URL hostname is required', 400);
  if (
    BLOCKED_HOSTNAMES.has(host) ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new WriteValidationError('Refusing private or local network URL', 400);
  }

  if (net.isIP(host) !== 0) {
    if (!isPublicIp(host)) {
      throw new WriteValidationError('Refusing private or loopback IP address', 400);
    }
    return url;
  }

  let resolved: DnsAddress[];
  try {
    resolved = await dnsLookup(host);
  } catch {
    throw new WriteValidationError(`Could not resolve hostname: ${host}`, 400);
  }
  if (resolved.length === 0 || resolved.some((entry) => !isPublicIp(entry.address))) {
    throw new WriteValidationError('Refusing host resolving to private or reserved IP address', 400);
  }

  return url;
}

async function readResponseBytesWithLimit(
  response: Response,
  limitBytes: number,
  tooLargeMessage: string
): Promise<Buffer> {
  const lenHeader = response.headers.get('content-length');
  if (lenHeader && Number(lenHeader) > limitBytes) {
    throw new WriteValidationError(tooLargeMessage, 413);
  }
  if (!response.body) {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.byteLength > limitBytes) {
      throw new WriteValidationError(tooLargeMessage, 413);
    }
    return buf;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      received += value.byteLength;
      if (received > limitBytes) {
        await reader.cancel().catch(() => undefined);
        throw new WriteValidationError(tooLargeMessage, 413);
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks);
}

async function readResponseWithLimit(response: Response, limitBytes: number): Promise<string> {
  const buf = await readResponseBytesWithLimit(
    response,
    limitBytes,
    'Target page exceeds maximum 5 MB clip size'
  );
  return buf.toString('utf8');
}

const IMAGE_EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};

function detectImageMime(buffer: Buffer): string | null {
  if (buffer.length >= 4) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return 'image/gif';
    if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00) return 'image/x-icon';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return 'image/bmp';
  }
  if (buffer.length >= 12) {
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
      return 'image/webp';
    }
    if (buffer.toString('ascii', 4, 8) === 'ftyp') {
      const brand = buffer.toString('ascii', 8, 12);
      if (brand === 'avif' || brand === 'avis') return 'image/avif';
    }
  }
  const snippet = buffer.toString('utf8', 0, Math.min(buffer.length, 256)).trim().toLowerCase();
  if (snippet.startsWith('<svg') || (snippet.startsWith('<?xml') && snippet.includes('<svg'))) {
    return 'image/svg+xml';
  }
  return null;
}

function imageFilenameFromUrl(url: URL, mime: string): string {
  const ext = IMAGE_EXT_BY_MIME[mime] ?? 'bin';
  const segments = url.pathname.split('/').filter(Boolean);
  let base = segments.length > 0 ? segments[segments.length - 1] : '';
  try {
    base = decodeURIComponent(base);
  } catch {
    // keep raw segment
  }
  base = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 120);
  if (!base) return `image.${ext}`;
  if (!/\.[a-z0-9]{2,5}$/i.test(base)) {
    return `${base}.${ext}`;
  }
  return base;
}

/**
 * Downloads a single remote image through SSRF checks (initial URL and every redirect hop),
 * enforcing the same redirect, timeout, and size limits as page fetches.
 */
export async function fetchRemoteImage(
  rawUrl: string,
  deps: { dnsLookup?: DnsLookupFn; fetchFn?: FetchRemoteFn; maxBytes?: number } = {}
): Promise<{ name: string; mime: string; data: Buffer }> {
  const dnsLookup = deps.dnsLookup ?? defaultDnsLookup;
  const fetchFn = deps.fetchFn ?? defaultFetchRemote;
  const maxBytes = deps.maxBytes ?? MAX_CLIP_BYTES;

  let currentUrl = await assertSafeRemoteUrl(rawUrl, dnsLookup);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await fetchFn(currentUrl.toString(), {
        headers: {
          'User-Agent': 'JoplinWebClipper/1.0 (+https://joplinapp.org)',
          Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml,image/*;q=0.8,*/*;q=0.1',
        },
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || hop === MAX_REDIRECTS) {
          throw new WriteValidationError('Too many or invalid redirects while fetching image', 400);
        }
        currentUrl = await assertSafeRemoteUrl(new URL(location, currentUrl).toString(), dnsLookup);
        continue;
      }

      if (!response.ok) {
        throw new WriteValidationError(`Image returned HTTP ${response.status}`, 502);
      }

      const rawType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (rawType && !rawType.startsWith('image/') && rawType !== 'application/octet-stream') {
        throw new WriteValidationError(`Unsupported image content type: ${rawType}`, 415);
      }

      const data = await readResponseBytesWithLimit(
        response,
        maxBytes,
        'Image exceeds maximum 5 MB clip size'
      );
      if (data.length === 0) {
        throw new WriteValidationError('Image response was empty', 400);
      }

      const sniffed = detectImageMime(data);
      const mime = rawType.startsWith('image/') ? rawType : sniffed;
      if (!mime || !mime.startsWith('image/')) {
        throw new WriteValidationError('Response is not a recognized image', 415);
      }

      return {
        name: imageFilenameFromUrl(currentUrl, mime),
        mime,
        data,
      };
    }

    throw new WriteValidationError('Image redirect limit exceeded', 400);
  } finally {
    clearTimeout(timer);
  }
}

export function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  td.remove(['script', 'style', 'noscript', 'iframe', 'svg']);
  return td;
}

const JOPLIN_RESOURCE_REF = /^:\/[0-9a-f]{32}$/i;
const SAFE_DATA_IMAGE_URI = /^data:image\/(?:png|jpeg|jpg|gif|webp|avif|bmp);/i;
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'poster', 'background', 'cite']);

function normalizeProtocol(val: string): string {
  return val.replace(/[\u0000-\u0020]+/g, '').toLowerCase();
}

function isDangerousUrl(val: string, attrName: string): boolean {
  const normalized = normalizeProtocol(val);
  if (JOPLIN_RESOURCE_REF.test(normalized)) return false;
  if (/^(javascript|vbscript):/.test(normalized)) return true;
  if (normalized.startsWith('data:')) {
    return !(attrName === 'src' && SAFE_DATA_IMAGE_URI.test(normalized));
  }
  return false;
}

/** Escapes text for safe insertion into HTML content and attribute values. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Converts already-extracted HTML into Markdown using the shared Turndown configuration.
 * Preserves Joplin resource links (`:/<32-hex-id>`) and strips `javascript:` / `vbscript:` links.
 */
export function htmlToMarkdown(html: string): string {
  if (!html || !html.trim()) return '';
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  for (const el of document.body.querySelectorAll('a[href], img[src]') as unknown as Iterable<{
    hasAttribute(name: string): boolean;
    getAttribute(name: string): string | null;
    removeAttribute(name: string): void;
  }>) {
    const attr = el.hasAttribute('href') ? 'href' : 'src';
    const val = el.getAttribute(attr);
    if (val && isDangerousUrl(val, attr)) {
      el.removeAttribute(attr);
    }
  }
  return createTurndown().turndown(document.body.innerHTML).trim();
}

/**
 * Sanitizes clipped HTML for storage as a Joplin HTML note (`markup_language: 2`).
 * Strips active/embedded elements (`script`, `style`, `iframe`, `object`, `embed`, `form`, `noscript`,
 * `base`, `meta`, `link`), all `on*` event handler attributes, `srcdoc`, and `javascript:` /
 * `vbscript:` / unsafe `data:` URLs while keeping Joplin `:/<id>` attachment links intact.
 */
export function sanitizeClippedHtml(html: string): string {
  if (!html || !html.trim()) return '';
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  for (const el of Array.from(
    document.body.querySelectorAll('script, style, iframe, object, embed, form, noscript, base, meta, link') as unknown as Iterable<{
      remove(): void;
    }>
  )) {
    el.remove();
  }

  for (const el of Array.from(
    document.body.querySelectorAll('*') as unknown as Iterable<{
      attributes: Iterable<{ name: string; value: string }>;
      removeAttribute(name: string): void;
    }>
  )) {
    const attrs = Array.from(el.attributes);
    for (const { name, value } of attrs) {
      const lower = name.toLowerCase();
      if (lower.startsWith('on') || lower === 'srcdoc') {
        el.removeAttribute(name);
        continue;
      }
      if (URL_ATTRS.has(lower) && isDangerousUrl(value, lower)) {
        el.removeAttribute(name);
      }
    }
  }

  return document.body.innerHTML.trim();
}

export interface ClippedArticle {
  url: string;
  title: string;
  markdown: string;
  contentHtml?: string;
  byline?: string;
  siteName?: string;
  skippedImages?: number;
}

function pickLargestFromSrcset(srcset: string): string {
  let bestUrl = '';
  let bestScore = -1;
  for (const part of srcset.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    const candidate = tokens[0];
    if (!candidate) continue;
    const descriptor = tokens[1] || '';
    let score = 0;
    const wMatch = /^(\d+)w$/i.exec(descriptor);
    const xMatch = /^(\d+(?:\.\d+)?)x$/i.exec(descriptor);
    if (wMatch) score = Number(wMatch[1]);
    else if (xMatch) score = Number(xMatch[1]) * 1000;
    if (score >= bestScore) {
      bestScore = score;
      bestUrl = candidate;
    }
  }
  return bestUrl;
}

export function extractArticleFromHtml(html: string, pageUrl: string): ClippedArticle {
  const { document } = parseHTML(html);

  // Resolve lazy-load attributes and srcset on <img> before Readability & URL absolutization
  for (const img of document.querySelectorAll('img') as unknown as Iterable<{
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
  }>) {
    const currentSrc = img.getAttribute('src')?.trim() || '';
    const lazySrc =
      img.getAttribute('data-src')?.trim() ||
      img.getAttribute('data-original')?.trim() ||
      img.getAttribute('data-lazy-src')?.trim() ||
      '';
    if (lazySrc && (!currentSrc || currentSrc.startsWith('data:'))) {
      img.setAttribute('src', lazySrc);
    } else if (!currentSrc) {
      const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
      const best = pickLargestFromSrcset(srcset);
      if (best) img.setAttribute('src', best);
    }
  }

  const elements = document.querySelectorAll('a[href], img[src]') as unknown as Iterable<{
    hasAttribute(name: string): boolean;
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
  }>;
  for (const el of elements) {
    const attr = el.hasAttribute('href') ? 'href' : 'src';
    const val = el.getAttribute(attr);
    if (!val) continue;
    const trimmed = val.trim();
    if (JOPLIN_RESOURCE_REF.test(trimmed)) continue;
    if (/^(javascript|vbscript):/i.test(normalizeProtocol(trimmed))) {
      el.removeAttribute(attr);
      continue;
    }
    try {
      el.setAttribute(attr, new URL(trimmed, pageUrl).toString());
    } catch {
      // keep valid relative or fragment unchanged
    }
  }

  const parsedTitle =
    document.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() ||
    document.querySelector('title')?.textContent?.trim() ||
    '';

  const article = new Readability(
    document as unknown as ConstructorParameters<typeof Readability>[0]
  ).parse();

  const turndown = createTurndown();
  const contentHtml = article?.content || document.body?.innerHTML || '';
  const bodyMarkdown = contentHtml ? turndown.turndown(contentHtml).trim() : '';

  const title = (article?.title || parsedTitle || new URL(pageUrl).hostname).replace(/\s+/g, ' ').trim();
  return {
    url: pageUrl,
    title,
    markdown: bodyMarkdown,
    contentHtml,
    byline: article?.byline?.trim() || undefined,
    siteName: article?.siteName?.trim() || undefined,
  };
}

/**
 * Downloads remote `http:`/`https:` images referenced in `contentHtml` through SSRF checks,
 * uploads each via `uploadImage`, rewrites matching `<img src>` attributes to `:/<resourceId>`,
 * and converts the resulting HTML to Markdown. Caps at `MAX_CLIP_IMAGES` (50) and skips failures.
 */
async function embedRemoteImagesAndConvert(
  contentHtml: string,
  uploadImage: UploadClipImageFn,
  deps: { dnsLookup?: DnsLookupFn; fetchFn?: FetchRemoteFn }
): Promise<{ markdown: string; skippedImages: number }> {
  const { document } = parseHTML(`<!doctype html><html><body>${contentHtml}</body></html>`);
  const imgs = Array.from(
    document.body.querySelectorAll('img[src]') as unknown as Iterable<{
      getAttribute(name: string): string | null;
      setAttribute(name: string, value: string): void;
    }>
  );

  const uniqueUrls: string[] = [];
  const seen = new Set<string>();
  for (const img of imgs) {
    const src = img.getAttribute('src')?.trim();
    if (!src || !/^https?:\/\//i.test(src)) continue;
    if (!seen.has(src)) {
      seen.add(src);
      uniqueUrls.push(src);
    }
  }

  if (uniqueUrls.length === 0) {
    return { markdown: createTurndown().turndown(document.body.innerHTML).trim(), skippedImages: 0 };
  }

  const toFetch = uniqueUrls.slice(0, MAX_CLIP_IMAGES);
  let skippedImages = Math.max(0, uniqueUrls.length - toFetch.length);
  const urlToResourceId = new Map<string, string>();

  let next = 0;
  const worker = async () => {
    while (next < toFetch.length) {
      const imgUrl = toFetch[next++];
      let downloaded: { name: string; mime: string; data: Buffer };
      try {
        downloaded = await fetchRemoteImage(imgUrl, deps);
      } catch {
        skippedImages++;
        continue;
      }
      try {
        const uploaded = await uploadImage(downloaded);
        urlToResourceId.set(imgUrl, uploaded.id);
      } catch (err) {
        const status = (err as { status?: number })?.status;
        if (status === 401 || status === 422) throw err;
        skippedImages++;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(IMAGE_DOWNLOAD_CONCURRENCY, toFetch.length) }, worker)
  );

  for (const img of imgs) {
    const src = img.getAttribute('src')?.trim();
    if (!src) continue;
    const id = urlToResourceId.get(src);
    if (id) {
      img.setAttribute('src', `:/${id}`);
    }
  }

  return {
    markdown: createTurndown().turndown(document.body.innerHTML).trim(),
    skippedImages,
  };
}

export async function fetchAndClipUrl(
  rawUrl: string,
  deps: { dnsLookup?: DnsLookupFn; fetchFn?: FetchRemoteFn; uploadImage?: UploadClipImageFn } = {}
): Promise<ClippedArticle> {
  const dnsLookup = deps.dnsLookup ?? defaultDnsLookup;
  const fetchFn = deps.fetchFn ?? defaultFetchRemote;

  let currentUrl = await assertSafeRemoteUrl(rawUrl, dnsLookup);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await fetchFn(currentUrl.toString(), {
        headers: {
          'User-Agent': 'JoplinWebClipper/1.0 (+https://joplinapp.org)',
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        },
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || hop === MAX_REDIRECTS) {
          throw new WriteValidationError('Too many or invalid redirects while fetching URL', 400);
        }
        currentUrl = await assertSafeRemoteUrl(new URL(location, currentUrl).toString(), dnsLookup);
        continue;
      }

      if (!response.ok) {
        throw new WriteValidationError(`Target page returned HTTP ${response.status}`, 502);
      }

      const contentType = (response.headers.get('content-type') || 'text/html').split(';')[0].trim().toLowerCase();
      if (
        contentType &&
        contentType !== 'text/html' &&
        contentType !== 'application/xhtml+xml' &&
        !contentType.startsWith('text/plain') &&
        contentType !== 'text/markdown'
      ) {
        throw new WriteValidationError(`Unsupported content type for clipping: ${contentType}`, 415);
      }

      const text = await readResponseWithLimit(response, MAX_CLIP_BYTES);
      if (contentType === 'text/plain' || contentType === 'text/markdown') {
        const host = currentUrl.hostname;
        return { url: currentUrl.toString(), title: host, markdown: text.trim() };
      }
      const extracted = extractArticleFromHtml(text, currentUrl.toString());
      if (deps.uploadImage && extracted.contentHtml) {
        const { markdown, skippedImages } = await embedRemoteImagesAndConvert(
          extracted.contentHtml,
          deps.uploadImage,
          { dnsLookup, fetchFn }
        );
        return {
          ...extracted,
          markdown,
          skippedImages,
        };
      }
      return extracted;
    }

    throw new WriteValidationError('Redirect limit exceeded', 400);
  } catch (err) {
    if (err instanceof WriteValidationError) throw err;
    if ((err as { status?: number })?.status === 401 || (err as { status?: number })?.status === 422) {
      throw err;
    }
    if ((err as { name?: string })?.name === 'AbortError') {
      throw new WriteValidationError('Timed out while fetching target URL', 504);
    }
    throw new WriteValidationError('Failed to fetch target URL', 502);
  } finally {
    clearTimeout(timer);
  }
}

export interface ParsedEmail {
  subject: string;
  from: string;
  date: string;
  markdownBody: string;
}

function decodeBytesWithCharset(bytes: Buffer | Uint8Array, charset?: string): string {
  const normalized = (charset || 'utf-8').trim().replace(/^["']|["']$/g, '').toLowerCase();
  const mapped =
    normalized === 'utf8'
      ? 'utf-8'
      : normalized === 'latin1' || normalized === 'iso-8859-1' || normalized === 'us-ascii' || normalized === 'ascii'
      ? 'windows-1252'
      : normalized;
  try {
    return new TextDecoder(mapped).decode(bytes);
  } catch {
    return Buffer.from(bytes).toString('utf8');
  }
}

function decodeRfc2047(value: string): string {
  // RFC 2047 §6.2: linear whitespace separating adjacent encoded-words is ignored
  const collapsed = value.replace(/(\?=)\s+(=\?)/g, '$1$2');
  return collapsed.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_match, charset, enc, data) => {
    try {
      const upper = String(enc).toUpperCase();
      let buf: Buffer;
      if (upper === 'B') {
        buf = Buffer.from(data, 'base64');
      } else {
        const qp = String(data).replace(/_/g, ' ');
        const bytes: number[] = [];
        for (let i = 0; i < qp.length; i++) {
          if (qp[i] === '=' && /^[0-9a-fA-F]{2}$/.test(qp.slice(i + 1, i + 3))) {
            bytes.push(parseInt(qp.slice(i + 1, i + 3), 16));
            i += 2;
          } else {
            for (const b of Buffer.from(qp[i], 'utf8')) bytes.push(b);
          }
        }
        buf = Buffer.from(bytes);
      }
      return decodeBytesWithCharset(buf, String(charset));
    } catch {
      return _match;
    }
  });
}

function decodeTransferBody(
  raw: string,
  encoding: string,
  charset?: string,
  fromRawBytes = false
): string {
  const enc = encoding.trim().toLowerCase();
  if (enc === 'base64') {
    return decodeBytesWithCharset(Buffer.from(raw.replace(/\s+/g, ''), 'base64'), charset);
  }
  if (enc === 'quoted-printable') {
    const unfolded = raw.replace(/=\r?\n/g, '');
    const bytes: number[] = [];
    for (let i = 0; i < unfolded.length; i++) {
      if (unfolded[i] === '=' && /^[0-9a-fA-F]{2}$/.test(unfolded.slice(i + 1, i + 3))) {
        bytes.push(parseInt(unfolded.slice(i + 1, i + 3), 16));
        i += 2;
      } else if (fromRawBytes) {
        bytes.push(unfolded.charCodeAt(i) & 0xff);
      } else {
        const chunk = Buffer.from(unfolded[i], 'utf8');
        for (const b of chunk) bytes.push(b);
      }
    }
    return decodeBytesWithCharset(Buffer.from(bytes), charset);
  }
  if (fromRawBytes) {
    return decodeBytesWithCharset(Buffer.from(raw, 'latin1'), charset);
  }
  return raw;
}

function splitHeadersBody(raw: string): { headers: Record<string, string>; body: string } {
  const match = /\r?\n\r?\n/.exec(raw);
  const headerBlock = match ? raw.slice(0, match.index) : raw;
  const body = match ? raw.slice(match.index + match[0].length) : '';
  const unfolded = headerBlock.replace(/\r?\n([ \t]+)/g, ' ');
  const headers: Record<string, string> = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (!headers[key]) headers[key] = val;
  }
  return { headers, body };
}

function extractTextParts(
  rawPart: string,
  depth = 0,
  fromRawBytes = false
): { plain: string; html: string } {
  if (depth > 6) return { plain: '', html: '' };
  const { headers, body } = splitHeadersBody(rawPart);
  // Keep original case so case-sensitive MIME multipart boundaries remain intact
  const ctRaw = headers['content-type'] || 'text/plain';
  const ctLower = ctRaw.toLowerCase();
  const cte = headers['content-transfer-encoding'] || '';

  const boundaryMatch = /boundary=(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i.exec(ctRaw);
  const boundaryToken = boundaryMatch ? (boundaryMatch[1] ?? boundaryMatch[2] ?? boundaryMatch[3]) : '';
  if (ctLower.startsWith('multipart/') && boundaryToken) {
    const boundary = `--${boundaryToken}`;
    const chunks = body.split(boundary).slice(1);
    const isAlternative = ctLower.startsWith('multipart/alternative');
    const plainParts: string[] = [];
    const htmlParts: string[] = [];
    for (const chunk of chunks) {
      if (chunk.startsWith('--')) break;
      const trimmed = chunk.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
      const sub = extractTextParts(trimmed, depth + 1, fromRawBytes);
      if (isAlternative) {
        if (plainParts.length === 0 && sub.plain) plainParts.push(sub.plain);
        if (htmlParts.length === 0 && sub.html) htmlParts.push(sub.html);
      } else {
        if (sub.plain.trim()) plainParts.push(sub.plain.trim());
        if (sub.html.trim()) htmlParts.push(sub.html.trim());
      }
    }
    return {
      plain: plainParts.join('\n\n'),
      html: htmlParts.join('\n\n'),
    };
  }

  if (ctLower.startsWith('message/rfc822')) {
    return extractTextParts(body, depth + 1, fromRawBytes);
  }

  const charsetMatch = /charset=(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i.exec(ctRaw);
  const charset = charsetMatch ? (charsetMatch[1] ?? charsetMatch[2] ?? charsetMatch[3]) : undefined;
  const decoded = decodeTransferBody(body, cte, charset, fromRawBytes);
  if (ctLower.includes('text/html')) return { plain: '', html: decoded };
  if (ctLower.includes('text/plain') || !ctLower.includes('/')) return { plain: decoded, html: '' };
  return { plain: '', html: '' };
}

export function parseEmlMessage(rawEml: string | Buffer): ParsedEmail {
  const fromRawBytes = Buffer.isBuffer(rawEml);
  const source = fromRawBytes ? rawEml.toString('latin1') : rawEml;
  const { headers } = splitHeadersBody(source);
  const headerToText = (raw: string) =>
    fromRawBytes ? decodeBytesWithCharset(Buffer.from(raw, 'latin1'), 'utf-8') : raw;
  const subject = decodeRfc2047(headerToText(headers.subject || 'Forwarded Email'))
    .replace(/\s+/g, ' ')
    .trim();
  const from = decodeRfc2047(headerToText(headers.from || '')).trim();
  const date = (headers.date || '').trim();
  const { plain, html } = extractTextParts(source, 0, fromRawBytes);

  let markdownBody = plain.trim();
  if (!markdownBody && html.trim()) {
    markdownBody = createTurndown().turndown(html).trim();
  }
  return { subject, from, date, markdownBody };
}
