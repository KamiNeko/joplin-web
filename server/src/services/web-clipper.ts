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

async function readResponseWithLimit(response: Response, limitBytes: number): Promise<string> {
  const lenHeader = response.headers.get('content-length');
  if (lenHeader && Number(lenHeader) > limitBytes) {
    throw new WriteValidationError('Target page exceeds maximum 5 MB clip size', 413);
  }
  if (!response.body) {
    return response.text();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      received += value.byteLength;
      if (received > limitBytes) {
        await reader.cancel().catch(() => undefined);
        throw new WriteValidationError('Target page exceeds maximum 5 MB clip size', 413);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  td.remove(['script', 'style', 'noscript', 'iframe', 'svg']);
  return td;
}

export interface ClippedArticle {
  url: string;
  title: string;
  markdown: string;
  byline?: string;
  siteName?: string;
}

export function extractArticleFromHtml(html: string, pageUrl: string): ClippedArticle {
  const { document } = parseHTML(html);

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
    if (/^(javascript|vbscript):/i.test(trimmed)) {
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
    byline: article?.byline?.trim() || undefined,
    siteName: article?.siteName?.trim() || undefined,
  };
}

export async function fetchAndClipUrl(
  rawUrl: string,
  deps: { dnsLookup?: DnsLookupFn; fetchFn?: FetchRemoteFn } = {}
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
      return extractArticleFromHtml(text, currentUrl.toString());
    }

    throw new WriteValidationError('Redirect limit exceeded', 400);
  } catch (err) {
    if (err instanceof WriteValidationError) throw err;
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

function decodeRfc2047(value: string): string {
  return value.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_match, charset, enc, data) => {
    try {
      const upper = String(enc).toUpperCase();
      let buf: Buffer;
      if (upper === 'B') {
        buf = Buffer.from(data, 'base64');
      } else {
        const qp = String(data)
          .replace(/_/g, ' ')
          .replace(/=([0-9a-fA-F]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
        buf = Buffer.from(qp, 'latin1');
      }
      void charset;
      return buf.toString('utf8');
    } catch {
      return _match;
    }
  });
}

function decodeTransferBody(raw: string, encoding: string): string {
  const enc = encoding.trim().toLowerCase();
  if (enc === 'base64') {
    return Buffer.from(raw.replace(/\s+/g, ''), 'base64').toString('utf8');
  }
  if (enc === 'quoted-printable') {
    const unfolded = raw.replace(/=\r?\n/g, '');
    const bytes: number[] = [];
    for (let i = 0; i < unfolded.length; i++) {
      if (unfolded[i] === '=' && /^[0-9a-fA-F]{2}$/.test(unfolded.slice(i + 1, i + 3))) {
        bytes.push(parseInt(unfolded.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        const chunk = Buffer.from(unfolded[i], 'utf8');
        for (const b of chunk) bytes.push(b);
      }
    }
    return Buffer.from(bytes).toString('utf8');
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
  depth = 0
): { plain: string; html: string } {
  if (depth > 4) return { plain: '', html: '' };
  const { headers, body } = splitHeadersBody(rawPart);
  const ct = (headers['content-type'] || 'text/plain').toLowerCase();
  const cte = headers['content-transfer-encoding'] || '';

  const boundaryMatch = /boundary=["']?([^"';\s]+)["']?/i.exec(ct);
  if (ct.startsWith('multipart/') && boundaryMatch) {
    const boundary = `--${boundaryMatch[1]}`;
    const chunks = body.split(boundary).slice(1);
    let plain = '';
    let html = '';
    for (const chunk of chunks) {
      if (chunk.startsWith('--')) break;
      const trimmed = chunk.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
      const sub = extractTextParts(trimmed, depth + 1);
      if (!plain && sub.plain) plain = sub.plain;
      if (!html && sub.html) html = sub.html;
    }
    return { plain, html };
  }

  const decoded = decodeTransferBody(body, cte);
  if (ct.includes('text/html')) return { plain: '', html: decoded };
  if (ct.includes('text/plain') || !ct.includes('/')) return { plain: decoded, html: '' };
  return { plain: '', html: '' };
}

export function parseEmlMessage(rawEml: string): ParsedEmail {
  const { headers } = splitHeadersBody(rawEml);
  const subject = decodeRfc2047(headers.subject || 'Forwarded Email').replace(/\s+/g, ' ').trim();
  const from = decodeRfc2047(headers.from || '').trim();
  const date = (headers.date || '').trim();
  const { plain, html } = extractTextParts(rawEml);

  let markdownBody = plain.trim();
  if (!markdownBody && html.trim()) {
    markdownBody = createTurndown().turndown(html).trim();
  }
  return { subject, from, date, markdownBody };
}
