import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import type { AppConfig } from '../src/config.js';
import { startMockJoplinServer, type MockJoplinServer } from '../demo/mock-joplin-server.js';
import { buildDemoItems, DEMO_EMAIL, DEMO_PASSWORD, demoId } from '../demo/seed.js';
import { JoplinItemType } from '../src/types/index.js';
import type {
  fetchAndClipUrl as FetchAndClipUrlFn,
  htmlToMarkdown as HtmlToMarkdownFn,
  sanitizeClippedHtml as SanitizeClippedHtmlFn,
  DnsLookupFn,
  FetchRemoteFn,
} from '../src/services/web-clipper.js';
import { mockItem, mockItemsOfType } from './helpers.js';

// Minimal valid 1x1 PNG binary
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex'
);

let mock: MockJoplinServer;
let baseConfig: AppConfig;
let createApp: typeof import('../src/app.js').createApp;
let fetchAndClipUrl: typeof FetchAndClipUrlFn;
let htmlToMarkdown: typeof HtmlToMarkdownFn;
let sanitizeClippedHtml: typeof SanitizeClippedHtmlFn;
const servers: Server[] = [];

before(async () => {
  mock = await startMockJoplinServer({ email: DEMO_EMAIL, password: DEMO_PASSWORD, items: buildDemoItems() });
  process.env.JOPLIN_SERVER_URL = mock.url;
  process.env.CACHE_TTL_MS = '0';
  const { loadConfig } = await import('../src/config.js');
  ({ createApp } = await import('../src/app.js'));
  ({ fetchAndClipUrl, htmlToMarkdown, sanitizeClippedHtml } = await import('../src/services/web-clipper.js'));
  baseConfig = { ...loadConfig(), clientDistPath: '/nonexistent', corsOrigin: false };
});

after(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await mock.close();
});

async function startClipApp(fetchClip?: typeof fetchAndClipUrl): Promise<{ baseUrl: string; token: string }> {
  const app = createApp(baseConfig, { fetchClip });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
  });
  const loginData = (await loginRes.json()) as { sessionId: string };
  return { baseUrl, token: loginData.sessionId };
}

async function apiPost(baseUrl: string, token: string, path: string, payload: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  const data = (await res.json()) as any;
  return { status: res.status, data };
}

describe('web clipper HTML & Markdown helpers', () => {
  test('htmlToMarkdown keeps Joplin :/resourceId links intact and strips javascript: URLs', () => {
    const resId = '0123456789abcdef0123456789abcdef';
    const md = htmlToMarkdown(
      `<h1>Clip Title</h1><p>Photo: <img src=":/${resId}" alt="Demo"></p><p><a href="javascript:alert(1)">Bad</a> and <a href="https://example.com/ok">Good</a></p><script>evil()</script>`
    );
    assert.ok(md.includes(`![Demo](:/${resId})`), `expected :/id image link in: ${md}`);
    assert.ok(md.includes('[Good](https://example.com/ok)'));
    assert.ok(!md.includes('javascript:'));
    assert.ok(!md.includes('evil()'));
  });

  test('sanitizeClippedHtml removes dangerous tags, event handlers, and javascript: URLs while preserving :/id images', () => {
    const resId = 'fedcba9876543210fedcba9876543210';
    const dirty = [
      '<div onclick="alert(1)" data-ok="yes">',
      '<script>alert(2)</script>',
      '<style>body{display:none}</style>',
      '<iframe src="https://evil.example"></iframe>',
      '<object data="x"></object><embed src="y">',
      '<form action="https://evil.example"><input name="pw"></form>',
      `<img src=":/${resId}" onerror="alert(3)" alt="safe">`,
      '<a href="  JaVaScRiPt:alert(4)">Click</a>',
      '<a href="https://example.com/safe">Safe</a>',
      '</div>',
    ].join('');
    const clean = sanitizeClippedHtml(dirty);
    assert.ok(clean.includes(`src=":/${resId}"`), `expected :/id preserved in: ${clean}`);
    assert.ok(clean.includes('https://example.com/safe'));
    assert.ok(!/<script/i.test(clean));
    assert.ok(!/<style/i.test(clean));
    assert.ok(!/<iframe/i.test(clean));
    assert.ok(!/<object/i.test(clean));
    assert.ok(!/<embed/i.test(clean));
    assert.ok(!/<form/i.test(clean));
    assert.ok(!/onclick|onerror/i.test(clean));
    assert.ok(!/javascript:/i.test(clean));
  });
});

describe('POST /api/clip/html', () => {
  test('saves markdown and HTML notes with :/id images, tags, notebook fallback, and validation', async () => {
    const { baseUrl, token } = await startClipApp();
    const resId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

    // Missing required fields -> 400
    assert.equal((await apiPost(baseUrl, token, '/api/clip/html', {})).status, 400);
    assert.equal(
      (await apiPost(baseUrl, token, '/api/clip/html', { url: 'https://example.com', html: '<p>Hi</p>' })).status,
      400
    );
    assert.equal(
      (await apiPost(baseUrl, token, '/api/clip/html', { url: 'https://example.com', title: 'No body' })).status,
      400
    );
    assert.equal(
      (
        await apiPost(baseUrl, token, '/api/clip/html', {
          url: 'javascript:alert(1)',
          title: 'Bad URL',
          html: '<p>Hi</p>',
        })
      ).status,
      400
    );
    assert.equal(
      (
        await apiPost(baseUrl, token, '/api/clip/html', {
          url: 'https://example.com',
          title: 'Bad format',
          html: '<p>Hi</p>',
          format: 'pdf',
        })
      ).status,
      400
    );

    // Markdown clip with explicit notebook, tags (capped at 10), byline, and :/id image
    const mdRes = await apiPost(baseUrl, token, '/api/clip/html', {
      url: 'https://blog.example.com/post',
      title: 'Rendered Article',
      html: `<article><p>Hello <strong>world</strong></p><img src=":/${resId}" alt="Hero"></article>`,
      format: 'markdown',
      parentId: demoId('nb-work'),
      tags: ['clip', 'reading', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10', 't11'],
      byline: 'Jane Doe',
      siteName: 'Example Blog',
    });
    assert.equal(mdRes.status, 201);
    assert.equal(mdRes.data.note.title, 'Rendered Article');
    assert.equal(mdRes.data.note.parentId, demoId('nb-work'));
    assert.equal(mdRes.data.note.markupLanguage, 1);
    assert.equal(mdRes.data.note.properties.source_url, 'https://blog.example.com/post');
    assert.equal(mdRes.data.note.properties.author, 'Jane Doe');
    assert.ok(mdRes.data.note.body.includes('> Clipped from https://blog.example.com/post · by Jane Doe'));
    assert.ok(mdRes.data.note.body.includes(`![Hero](:/${resId})`));
    assert.equal(mdRes.data.note.tags.length, 10);
    assert.equal(mdRes.data.siteName, 'Example Blog');

    // HTML clip with sanitization and notebook fallback (no parentId)
    const htmlRes = await apiPost(baseUrl, token, '/api/clip/html', {
      url: 'https://full.example.com/page?a=1&b=2',
      title: 'Full Page Clip',
      html: `<div onclick="evil()"><script>bad()</script><iframe src="https://x.test"></iframe><form><input></form><p>Kept</p><img src=":/${resId}" onerror="x()"><a href="javascript:alert(1)">Link</a></div>`,
      format: 'html',
      tags: ['fullpage'],
      byline: '<b>Author</b>',
    });
    assert.equal(htmlRes.status, 201);
    assert.equal(htmlRes.data.note.markupLanguage, 2);
    assert.ok(htmlRes.data.note.parentId, 'falls back to default writable notebook');
    assert.ok(htmlRes.data.note.body.includes('Kept'));
    assert.ok(htmlRes.data.note.body.includes(`src=":/${resId}"`));
    assert.ok(htmlRes.data.note.body.includes('&lt;b&gt;Author&lt;/b&gt;'), 'byline is HTML-escaped in banner');
    assert.ok(!/<script|<iframe|<form|onclick|onerror|javascript:/i.test(htmlRes.data.note.body));
    assert.ok(htmlRes.data.note.tags.some((t: any) => t.title === 'fullpage'));
    assert.ok(mockItem(mock, htmlRes.data.note.id));
  });
});

describe('POST /api/clip image downloads', () => {
  test('downloads public article images into Joplin attachments and refuses private-IP images', async () => {
    const publicDns: DnsLookupFn = async (hostname) => {
      if (hostname === 'internal.example.com') return [{ address: '10.0.0.8', family: 4 }];
      return [{ address: '93.184.216.34', family: 4 }];
    };

    const fetchedUrls: string[] = [];
    const mockFetch: FetchRemoteFn = async (url) => {
      fetchedUrls.push(url);
      if (url === 'https://news.example.com/story') {
        return new Response(
          `<!doctype html><html><head><title>Photo Story</title></head><body><article>` +
            `<h1>Photo Story</h1>` +
            `<p>A long enough paragraph so Readability treats this section as the main article body without dropping any elements.</p>` +
            `<p><img src="/img/photo.png" alt="Public Photo"></p>` +
            `<p><img data-src="https://news.example.com/img/lazy.png" alt="Lazy Photo"></p>` +
            `<p><img src="http://127.0.0.1/secret.png" alt="Loopback"></p>` +
            `<p><img src="https://internal.example.com/lan.png" alt="Private DNS"></p>` +
            `<p><img src="https://news.example.com/img/missing.png" alt="Broken"></p>` +
            `</article></body></html>`,
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }
        );
      }
      if (url === 'https://news.example.com/img/photo.png' || url === 'https://news.example.com/img/lazy.png') {
        return new Response(TINY_PNG, { status: 200, headers: { 'content-type': 'image/png' } });
      }
      if (url === 'https://news.example.com/img/missing.png') {
        return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    const { baseUrl, token } = await startClipApp((url, deps) =>
      fetchAndClipUrl(url, { ...deps, dnsLookup: publicDns, fetchFn: mockFetch })
    );

    const beforeResources = mockItemsOfType(mock, JoplinItemType.Resource).length;
    const res = await apiPost(baseUrl, token, '/api/clip', {
      url: 'https://news.example.com/story',
      parentId: demoId('nb-work'),
      tags: ['news'],
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.skippedImages, 3);

    // Private-IP and private-DNS URLs were NEVER fetched
    assert.ok(!fetchedUrls.some((u) => u.includes('127.0.0.1')));
    assert.ok(!fetchedUrls.some((u) => u.includes('internal.example.com')));

    const afterResources = mockItemsOfType(mock, JoplinItemType.Resource);
    assert.equal(afterResources.length, beforeResources + 2);

    // Both public images were rewritten to :/resourceId links
    const matches = [...(res.data.note.body as string).matchAll(/!\[[^\]]*\]\(:\/([0-9a-f]{32})\)/g)];
    assert.equal(matches.length, 2, `expected 2 :/id image links in:\n${res.data.note.body}`);
    for (const m of matches) {
      const bin = mock.items.get(`.resource/${m[1]}`);
      assert.ok(bin, `resource binary for ${m[1]} exists`);
      assert.deepEqual(bin.content, TINY_PNG);
    }
  });
});
