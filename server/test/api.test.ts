import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, mock as testMock, test } from 'node:test';
import type { MockJoplinServer } from '../demo/mock-joplin-server.js';
import { DEMO_EMAIL, DEMO_PASSWORD, demoId } from '../demo/seed.js';
import type { AppConfig } from '../src/config.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * End-to-end tests of the Express API against the in-memory mock Joplin Server (no network access).
 */

let app: TestApp;
let mock: MockJoplinServer;
let session: string;

const api = (path: string, init: RequestInit = {}, auth = true) => app.api(path, init, auth);

before(async () => {
  app = await startTestApp({ pageSize: 7 });
  mock = app.mock;
});

after(() => app.close());

describe('auth', () => {
  test('health check is public', async () => {
    const res = await api('/api/health', {}, false);
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'ok');
    assert.equal(typeof res.data.version, 'string');
    assert.ok(res.data.commit === null || /^[0-9a-f]{7,40}$/.test(res.data.commit));
    assert.deepEqual(Object.keys(res.data).sort(), ['commit', 'status', 'version'], 'health exposes build metadata only');
  });

  test('rejects requests without a session', async () => {
    assert.equal((await api('/api/auth/check', {}, false)).status, 401);
    assert.equal((await api('/api/notes', {}, false)).status, 401);
  });

  test('rejects wrong credentials', async () => {
    const res = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: DEMO_EMAIL, password: 'nope' }) }, false);
    assert.equal(res.status, 401);
  });

  test('logs in with valid credentials', async () => {
    const res = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }) }, false);
    assert.equal(res.status, 200);
    assert.ok(res.data.sessionId);
    session = app.session = res.data.sessionId;
    const check = await api('/api/auth/check');
    assert.equal(check.status, 200);
    assert.equal(check.data.valid, true);
    assert.equal(typeof check.data.serverHost, 'string', 'check returns the Joplin Server host');
    assert.ok(!String(check.data.serverHost).includes('/'), 'host only, no scheme or path');
  });
});

describe('reading', () => {
  test('builds the nested notebook tree across paginated listings', async () => {
    const res = await api('/api/notebooks');
    assert.equal(res.status, 200);
    const work = res.data.find((nb: any) => nb.title === 'Work');
    assert.ok(work, 'Work notebook present');
    assert.deepEqual(work.children.map((c: any) => c.title).sort(), ['Meeting Notes', 'Projects']);
  });

  test('lists notes of a notebook without trashed ones', async () => {
    const res = await api(`/api/notes?notebook_id=${demoId('nb-projects')}`);
    assert.equal(res.status, 200);
    const titles = res.data.map((n: any) => n.title);
    assert.ok(titles.includes('Website Relaunch Roadmap'));
    assert.ok(!titles.includes('Old draft: landing page copy'));
  });

  test('lists trashed notes', async () => {
    const res = await api('/api/notes?is_trash=true');
    assert.deepEqual(res.data.map((n: any) => n.title), ['Old draft: landing page copy']);
  });

  test('lists conflict copies only in the conflicts list', async () => {
    const res = await api('/api/notes?is_conflict=true');
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.map((n: any) => n.id), [demoId('note-roadmap-conflict')]);
    assert.equal(res.data[0].isConflict, true);
    const all = await api('/api/notes');
    assert.ok(!all.data.some((n: any) => n.id === demoId('note-roadmap-conflict')));
  });

  test('returns note details with tags', async () => {
    const res = await api(`/api/notes/${demoId('note-roadmap')}`);
    assert.equal(res.status, 200);
    assert.match(res.data.body, /## Goals/);
    assert.deepEqual(res.data.tags.map((t: any) => t.title).sort(), ['important', 'planning']);
    assert.equal(res.data.notebookTitle, 'Projects');
  });

  test('returns the markup language and plaintext previews of HTML notes', async () => {
    const html = await api(`/api/notes/${demoId('note-clipped-article')}`);
    assert.equal(html.status, 200);
    assert.equal(html.data.markupLanguage, 2);
    assert.match(html.data.body, /^<div class="clip">/);
    assert.equal((await api(`/api/notes/${demoId('note-roadmap')}`)).data.markupLanguage, 1);

    const list = await api(`/api/notes?notebook_id=${demoId('nb-reading')}`);
    const clipped = list.data.find((n: any) => n.id === demoId('note-clipped-article'));
    assert.ok(clipped.preview.startsWith('The Case for Slow Travel Saved with the Joplin Web Clipper from example.com'));
    assert.ok(!/[<>]/.test(clipped.preview), 'no raw tags in the preview');
    assert.ok(clipped.preview.includes('*regional*'), 'HTML text is not stripped as Markdown');
  });

  test('keeps markup_language when an HTML note is edited', async () => {
    const id = demoId('note-clipped-article');
    const before = await api(`/api/notes/${id}`);
    const res = await api(`/api/notes/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ body: `${before.data.body}\n<p>Added</p>`, baseUpdatedTime: before.data.updatedTime }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.markupLanguage, 2);
    assert.match(mock.items.get(`${id}.md`)!.content.toString('utf8'), /^markup_language: 2$/m);
  });

  test('searches titles and bodies', async () => {
    const res = await api('/api/search?q=miso');
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.map((n: any) => n.title), ['Weeknight Miso Ramen']);
  });

  /** Titles found for a search query, sorted */
  const searchTitles = async (q: string): Promise<string[]> => {
    const res = await api(`/api/search?q=${encodeURIComponent(q)}`);
    assert.equal(res.status, 200);
    return res.data.map((n: any) => n.title).sort();
  };

  test('search matches all words in any order, in title or body', async () => {
    assert.deepEqual(await searchTitles('ramen weeknight'), ['Weeknight Miso Ramen']);
    assert.deepEqual(await searchTitles('RAMEN Weeknight'), ['Weeknight Miso Ramen'], 'case-insensitive');
    assert.deepEqual(await searchTitles('ramen biometric'), [], 'every word must match');
    assert.deepEqual(await searchTitles('"ramen weeknight"'), [], 'a quoted phrase must match as written');
    assert.deepEqual(await searchTitles('"weeknight miso"'), ['Weeknight Miso Ramen']);
  });

  test('search returns matched terms and a snippet around the first body match', async () => {
    const res = await api('/api/search?q=passport%20biometric');
    assert.equal(res.data.length, 1);
    const { matches } = res.data[0];
    assert.deepEqual(matches.terms, ['passport', 'biometric']);
    assert.equal(matches.inTitle, true);
    assert.equal(matches.inBody, true);
    assert.match(matches.snippet, /biometric/);
  });

  test('search filters by tag, notebook (with sub-notebooks), type and completion', async () => {
    assert.deepEqual(await searchTitles('tag:cooking'), ['Sourdough Starter Schedule', 'Weeknight Miso Ramen']);
    assert.deepEqual(await searchTitles('tag:cooking miso'), ['Weeknight Miso Ramen']);
    assert.deepEqual(await searchTitles('tag:books tag:ideas'), ['Books to Read in 2026'], 'all tags must match');
    assert.deepEqual(await searchTitles('tag:"Cooking" -miso'), ['Sourdough Starter Schedule']);
    assert.deepEqual(await searchTitles('notebook:recipes'), ['Sourdough Starter Schedule', 'Weeknight Miso Ramen']);
    assert.deepEqual(await searchTitles('notebook:"reading list"'), [
      'Book Notes: Deep Work',
      'Books to Read in 2026',
      'Clipped: The Case for Slow Travel',
    ]);
    assert.deepEqual(
      await searchTitles('notebook:personal -notebook:recipes'),
      ['Book train tickets to Porto', 'Lisbon Long Weekend', 'Pay the electricity bill', 'Renew passport'],
      'sub-notebooks are included and can be excluded'
    );
    assert.deepEqual(await searchTitles('type:todo'), ['Book train tickets to Porto', 'Pay the electricity bill', 'Renew passport']);
    assert.deepEqual(await searchTitles('iscompleted:1'), ['Book train tickets to Porto']);
    assert.deepEqual(await searchTitles('iscompleted:0'), ['Pay the electricity bill', 'Renew passport']);
    assert.ok(!(await searchTitles('type:note')).includes('Renew passport'));
    assert.deepEqual(await searchTitles('tag:nosuchtag'), []);
  });

  test('search never returns trashed notes', async () => {
    assert.deepEqual(await searchTitles('landing'), []);
    assert.ok(!(await searchTitles('notebook:projects')).includes('Old draft: landing page copy'));
  });

  test('lists tags with note counts', async () => {
    const res = await api('/api/tags');
    const cooking = res.data.find((t: any) => t.title === 'cooking');
    assert.equal(cooking.noteCount, 2);
  });

  test('serves resource binaries with their MIME type', async () => {
    const res = await api(`/api/resources/${demoId('res-tram')}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /image\/svg\+xml/);
  });
});

describe('account', () => {
  test('reports a writable account without E2EE', async () => {
    const res = await api('/api/account/write-state');
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { writable: true });
  });

  test('write state requires a session', async () => {
    assert.equal((await api('/api/account/write-state', {}, false)).status, 401);
  });

  test('marks readable items as not encrypted', async () => {
    const notes = await api('/api/notes');
    assert.ok(notes.data.length > 0 && notes.data.every((n: any) => n.encrypted === false));
    const notebooks = await api('/api/notebooks');
    assert.ok(notebooks.data.every((nb: any) => nb.encrypted === false));
  });
});

describe('writing', () => {
  let noteId: string;
  let updatedTime: number;

  test('creates a note', async () => {
    const res = await api('/api/notes', {
      method: 'POST',
      body: JSON.stringify({ title: 'Test note', body: 'Hello **world**', parentId: demoId('nb-reading') }),
    });
    assert.equal(res.status, 201);
    noteId = res.data.id;
    updatedTime = res.data.updatedTime;
    assert.match(noteId, /^[0-9a-f]{32}$/);
    assert.ok(mock.items.has(`${noteId}.md`), 'written to Joplin Server');
  });

  test('updates a note', async () => {
    const res = await api(`/api/notes/${noteId}`, {
      method: 'PUT',
      body: JSON.stringify({ body: '# Changed **body**', baseUpdatedTime: updatedTime }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.body, '# Changed **body**');
    // Same preview as the note list, so the client can update its list entry without a refetch
    assert.equal(res.data.preview, 'Changed body');
    const list = await api(`/api/notes?notebookId=${demoId('nb-reading')}`);
    assert.equal(list.data.find((n: { id: string }) => n.id === noteId).preview, res.data.preview);
  });

  test('detects conflicting edits', async () => {
    const res = await api(`/api/notes/${noteId}`, {
      method: 'PUT',
      body: JSON.stringify({ body: 'Stale edit', baseUpdatedTime: updatedTime }),
    });
    assert.equal(res.status, 409);
  });

  test('trashes, restores and permanently deletes a note', async () => {
    assert.equal((await api(`/api/notes/${noteId}`, { method: 'DELETE' })).status, 204);
    assert.ok((await api(`/api/notes/${noteId}`)).data.deletedTime > 0);
    assert.equal((await api(`/api/notes/${noteId}/restore`, { method: 'POST' })).status, 200);
    assert.equal((await api(`/api/notes/${noteId}`)).data.deletedTime, 0);
    assert.equal((await api(`/api/notes/${noteId}`, { method: 'DELETE' })).status, 204); // only trashed notes can be purged
    assert.equal((await api(`/api/notes/${noteId}?permanent=true`, { method: 'DELETE' })).status, 204);
    assert.ok(!mock.items.has(`${noteId}.md`));
  });

  test('sets, changes and clears a to-do due date with conflict detection', async () => {
    const put = (id: string, payload: unknown) => api(`/api/notes/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    const storedDue = (id: string) => /^todo_due: (.*)$/m.exec(mock.items.get(`${id}.md`)!.content.toString('utf8'))?.[1];

    const created = await api('/api/notes', {
      method: 'POST',
      body: JSON.stringify({ title: 'Water plants', parentId: demoId('nb-personal'), isTodo: true }),
    });
    assert.equal(created.status, 201);
    const id = created.data.id;
    assert.equal(created.data.todoDue, 0);
    assert.equal(storedDue(id), '0');

    const due = Date.UTC(2026, 10, 3, 9, 30);
    const set = await put(id, { todoDue: due, baseUpdatedTime: created.data.updatedTime });
    assert.equal(set.status, 200);
    assert.equal(set.data.todoDue, due);
    assert.equal(set.data.title, 'Water plants', 'other fields are kept');
    assert.equal(storedDue(id), String(due), 'stored as Unix ms like Joplin desktop');
    assert.ok(set.data.updatedTime > created.data.updatedTime);
    const listed = (await api(`/api/notes?notebook_id=${demoId('nb-personal')}`)).data.find((n: any) => n.id === id);
    assert.equal(listed.todoDue, due, 'cache updated');

    const stale = await put(id, { todoDue: due + 1, baseUpdatedTime: created.data.updatedTime });
    assert.equal(stale.status, 409);
    assert.equal(storedDue(id), String(due));

    for (const bad of ['2026-11-03', -1, 1.5, 9e15, true, {}]) {
      assert.equal((await put(id, { todoDue: bad })).status, 400, `rejects ${JSON.stringify(bad)}`);
    }

    const cleared = await put(id, { todoDue: null, baseUpdatedTime: set.data.updatedTime });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.data.todoDue, 0);
    assert.equal(storedDue(id), '0');

    assert.equal((await put(demoId('note-roadmap'), { todoDue: due })).status, 400, 'plain notes cannot get a due date');
    assert.equal((await api(`/api/notes/${id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await api(`/api/notes/${id}?permanent=true`, { method: 'DELETE' })).status, 204);
  });

  test('rejects invalid ids before touching Joplin Server', async () => {
    const res = await api('/api/notes/..%2Fevil', { method: 'PUT', body: JSON.stringify({ body: 'x' }) });
    assert.equal(res.status, 400);
  });
});

describe('security', () => {
  async function upload(name: string, type: string, data: string | Buffer) {
    const res = await api('/api/resources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name), 'X-File-Type': type },
      // Buffer, so the api() helper doesn't mark it as JSON
      body: typeof data === 'string' ? Buffer.from(data) : data,
    });
    assert.equal(res.status, 201);
    return res.data.id as string;
  }

  test('serves SVG attachments as downloads with a sandboxing CSP', async () => {
    const res = await api(`/api/resources/${demoId('res-tram')}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^image\/svg\+xml/);
    assert.match(res.headers.get('content-disposition') ?? '', /^attachment/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'.*sandbox/);
  });

  test('never serves uploaded HTML or script with an executable type', async () => {
    for (const [name, type] of [
      ['evil.html', 'text/html'],
      ['evil.xhtml', 'application/xhtml+xml'],
      ['evil.js', 'text/javascript'],
      ['evil.xml', 'text/xml'],
      ['evil.html', 'application/octet-stream'],
    ]) {
      const id = await upload(name, type, '<html><script>alert(document.domain)</script></html>');
      const res = await api(`/api/resources/${id}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/octet-stream', `${name} as ${type}`);
      assert.match(res.headers.get('content-disposition') ?? '', /^attachment/);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    }
  });

  test('sniffed SVG uploads are not shown inline', async () => {
    const id = await upload('drawing', 'application/octet-stream', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const res = await api(`/api/resources/${id}`);
    assert.match(res.headers.get('content-type') ?? '', /^image\/svg\+xml/);
    assert.match(res.headers.get('content-disposition') ?? '', /^attachment/);
  });

  test('shows raster images inline', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const id = await upload('pixel.png', 'image/png', png);
    const res = await api(`/api/resources/${id}`);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.match(res.headers.get('content-disposition') ?? '', /^inline; filename="pixel\.png"/);
  });

  test('encodes attachment file names safely in Content-Disposition', async () => {
    const id = await upload('a"b\\c\';x=(1)*.txt', 'text/plain', 'hello');
    const header = (await api(`/api/resources/${id}`)).headers.get('content-disposition') ?? '';
    // (the upload already replaced the backslash)
    assert.equal(header, `inline; filename="a_b_c';x=(1)*.txt"; filename*=UTF-8''a%22b_c%27%3Bx%3D%281%29%2A.txt`);

    const { contentDisposition } = await import('../src/routes/resources.js');
    assert.equal(contentDisposition('attachment', 'Übersicht.pdf'), `attachment; filename="_bersicht.pdf"; filename*=UTF-8''%C3%9Cbersicht.pdf`);
    assert.equal(contentDisposition('attachment', 'x\r\nSet-Cookie: a=b'), `attachment; filename="xSet-Cookie: a=b"; filename*=UTF-8''xSet-Cookie%3A%20a%3Db`);
    assert.equal(contentDisposition('attachment', '\ud800'), 'attachment');
    assert.equal(contentDisposition('inline', undefined), 'inline');
  });

  test('normalizes malformed or unknown resource types', async () => {
    const { resourceResponseType } = await import('../src/routes/resources.js');
    assert.deepEqual(resourceResponseType('video/mp4'), { contentType: 'video/mp4', inline: true });
    assert.deepEqual(resourceResponseType('IMAGE/PNG; charset=x'), { contentType: 'image/png', inline: true });
    assert.deepEqual(resourceResponseType('audio/x\r\nX-Evil: 1'), { contentType: 'application/octet-stream', inline: false });
    assert.deepEqual(resourceResponseType(undefined), { contentType: 'application/octet-stream', inline: false });
  });

  test('validates resource ids', async () => {
    assert.equal((await api('/api/resources/..%2F..%2Fapi%2Fusers')).status, 400);
    assert.equal((await api('/api/resources/not-an-id')).status, 400);
  });

  test('does not accept session tokens in the query string', async () => {
    const res = await api(`/api/resources/${demoId('res-tram')}?auth=${session}`, {}, false);
    assert.equal(res.status, 401);
  });

  test('sends Referrer-Policy and a CSP that allows blob: images', async () => {
    const res = await api('/api/health', {}, false);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /img-src 'self' data: blob:/);
    assert.match(csp, /script-src 'self'/);
    assert.equal(res.data.joplinServer, undefined, 'health check does not disclose the Joplin Server URL');
  });

  test('error responses do not leak internals', async () => {
    const res = await api('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"broken' } as RequestInit);
    assert.equal(res.status, 400);
    assert.deepEqual(res.data, { error: 'Invalid request' });
  });

  test('redacts session tokens from logged URLs', async () => {
    const { redactUrl } = await import('../src/middleware/request-logger.js');
    assert.equal(redactUrl('/api/resources/abc?auth=SECRET&x=1'), '/api/resources/abc?auth=[REDACTED]&x=1');
    assert.equal(redactUrl('/a?x=1&Auth=SECRET#frag'), '/a?x=1&Auth=[REDACTED]#frag');
    assert.equal(redactUrl('/a?%61uth=SECRET'), '/a?%61uth=[REDACTED]');
    assert.equal(redactUrl('/a?password=hunter2&token=t'), '/a?password=[REDACTED]&token=[REDACTED]');
    assert.equal(redactUrl('/api/notes'), '/api/notes');
  });

  test('requires a valid JOPLIN_SERVER_URL instead of falling back to a default', async () => {
    const { loadConfig, ConfigError } = await import('../src/config.js');
    assert.throws(() => loadConfig({}), ConfigError);
    assert.throws(() => loadConfig({ JOPLIN_SERVER_URL: '  ' }), /JOPLIN_SERVER_URL is not set/);
    assert.throws(() => loadConfig({ JOPLIN_SERVER_URL: 'notes.example.com' }), ConfigError);
    assert.throws(() => loadConfig({ JOPLIN_SERVER_URL: 'file:///etc/passwd' }), ConfigError);
    assert.throws(() => loadConfig({ JOPLIN_SERVER_URL: 'https://user:pw@notes.example.com' }), ConfigError);
    assert.equal(loadConfig({ JOPLIN_SERVER_URL: 'https://notes.example.com//' }).joplinServerUrl, 'https://notes.example.com');
  });

  test('reads build metadata and only accepts plain version strings', async () => {
    const { loadConfig } = await import('../src/config.js');
    const base = { JOPLIN_SERVER_URL: 'https://notes.example.com' };
    assert.equal(loadConfig(base).appVersion, 'dev');
    assert.equal(loadConfig(base).gitSha, null);
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const tagged = loadConfig({ ...base, APP_VERSION: '1.2.0', GIT_SHA: sha });
    assert.equal(tagged.appVersion, '1.2.0');
    assert.equal(tagged.gitSha, sha);
    assert.equal(loadConfig({ ...base, APP_VERSION: '<script>', GIT_SHA: 'not-a-sha' }).appVersion, 'dev');
    assert.equal(loadConfig({ ...base, GIT_SHA: 'not-a-sha' }).gitSha, null);
  });

  test('reads RATE_LIMIT_MAX', async () => {
    const { loadConfig, ConfigError } = await import('../src/config.js');
    const base = { JOPLIN_SERVER_URL: 'https://notes.example.com' };
    assert.equal(loadConfig(base).rateLimitMax, 1000);
    assert.equal(loadConfig({ ...base, RATE_LIMIT_MAX: ' 5000 ' }).rateLimitMax, 5000);
    for (const bad of ['0', '-1', '1.5', 'lots']) {
      assert.throws(() => loadConfig({ ...base, RATE_LIMIT_MAX: bad }), ConfigError);
    }
  });

  test('allows no cross-origin callers in production unless CORS_ORIGIN is set', async () => {
    const { loadConfig } = await import('../src/config.js');
    const base = { JOPLIN_SERVER_URL: 'https://notes.example.com' };
    assert.equal(loadConfig({ ...base, NODE_ENV: 'production' }).corsOrigin, false);
    assert.equal(loadConfig(base).corsOrigin, 'http://localhost:5173');
    assert.deepEqual(loadConfig({ ...base, NODE_ENV: 'production', CORS_ORIGIN: 'https://a.test, https://b.test' }).corsOrigin, [
      'https://a.test',
      'https://b.test',
    ]);
  });
});

describe('note cache lifetime (#106)', () => {
  /** Logs in a second session and fills its note cache */
  async function cachedSession(): Promise<string> {
    const res = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }) }, false);
    assert.equal(res.status, 200);
    const other = res.data.sessionId as string;
    const read = await app.api('/api/notebooks', { headers: { Authorization: `Bearer ${other}` } }, false);
    assert.equal(read.status, 200);
    return other;
  }

  test('drops caches of idle sessions and keeps active ones', async () => {
    const { noteCache, IDLE_CACHE_TTL_MS } = await import('../src/services/note-cache.js');
    const idle = await cachedSession();
    assert.ok(noteCache.hasCache(idle));
    assert.equal(noteCache.evictIdleCaches(Date.now() + IDLE_CACHE_TTL_MS / 2), 0, 'recently used caches stay');
    assert.ok(noteCache.hasCache(idle));
    assert.ok(noteCache.evictIdleCaches(Date.now() + IDLE_CACHE_TTL_MS + 1000) >= 1);
    assert.ok(!noteCache.hasCache(idle));
    assert.ok(!noteCache.hasCache(session));
    // An evicted session that comes back gets a fresh listing
    assert.equal((await api('/api/notebooks')).status, 200);
    assert.ok(noteCache.hasCache(session));
  });

  test('frees the cache of a session that expired on Joplin Server', async () => {
    const { noteCache } = await import('../src/services/note-cache.js');
    const expired = await cachedSession();
    assert.ok(noteCache.hasCache(expired));
    await fetch(`${mock.url}/logout`, { method: 'POST', headers: { 'X-API-AUTH': expired }, redirect: 'manual' });
    const res = await app.api('/api/notebooks', { headers: { Authorization: `Bearer ${expired}` } }, false);
    assert.equal(res.status, 401);
    assert.ok(!noteCache.hasCache(expired));
    assert.ok(noteCache.hasCache(session), 'other sessions keep their cache');
  });
});

describe('logout', () => {
  test('logs out', async () => {
    const { noteCache } = await import('../src/services/note-cache.js');
    assert.equal((await api('/api/auth/logout', { method: 'POST' })).status, 200);
    assert.ok(!noteCache.hasCache(session));
  });
});

describe('remember me', () => {
  const servers: Server[] = [];
  const tempDirs: string[] = [];

  class CookieJar {
    private cookies = new Map<string, string>();
    ingest(headers: Headers): void {
      for (const raw of headers.getSetCookie()) {
        const semi = raw.indexOf(';');
        const nv = semi === -1 ? raw : raw.slice(0, semi);
        const eq = nv.indexOf('=');
        if (eq === -1) continue;
        const name = nv.slice(0, eq).trim();
        const val = nv.slice(eq + 1).trim();
        const attrs = semi === -1 ? '' : raw.slice(semi + 1);
        if (!val || /Max-Age=0\b/i.test(attrs) || /Expires=Thu, 01 Jan 1970/i.test(attrs)) {
          this.cookies.delete(name);
        } else {
          this.cookies.set(name, val);
        }
      }
    }
    get(name: string): string | undefined {
      return this.cookies.get(name);
    }
    set(name: string, val: string): void {
      this.cookies.set(name, val);
    }
    delete(name: string): void {
      this.cookies.delete(name);
    }
    header(): string {
      return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }
  }

  async function startRememberApp(overrides: Partial<AppConfig> = {}): Promise<{
    baseUrl: string;
    cacheDir: string | null;
  }> {
    const { loadConfig } = await import('../src/config.js');
    const { createApp } = await import('../src/app.js');
    const cacheDir =
      overrides.cacheDir === undefined
        ? await mkdtemp(path.join(os.tmpdir(), 'joplin-remember-'))
        : overrides.cacheDir;
    if (cacheDir) tempDirs.push(cacheDir);
    const appInstance = createApp({
      ...loadConfig(),
      clientDistPath: '/nonexistent',
      corsOrigin: 'http://localhost:5173',
      ...overrides,
      cacheDir,
    });
    const server: Server = await new Promise((resolve) => {
      const s = appInstance.listen(0, '127.0.0.1', () => resolve(s));
    });
    servers.push(server);
    return {
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      cacheDir,
    };
  }

  async function req(
    baseUrl: string,
    reqPath: string,
    init: RequestInit & { json?: unknown; jar?: CookieJar } = {}
  ) {
    const headers = new Headers(init.headers);
    if (init.jar && !headers.has('Cookie')) {
      const c = init.jar.header();
      if (c) headers.set('Cookie', c);
    }
    let body = init.body;
    if (init.json !== undefined) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(init.json);
    }
    const res = await fetch(`${baseUrl}${reqPath}`, { ...init, headers, body, redirect: 'manual' });
    if (init.jar) init.jar.ingest(res.headers);
    const text = await res.text();
    let data: any = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // plain text
    }
    return { status: res.status, data, headers: res.headers };
  }

  after(async () => {
    mock.onCreateSession = null;
    mock.setPassword(DEMO_PASSWORD);
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('without CACHE_DIR rememberMe is ignored, no cookie is set, and options report unavailable', async () => {
    const { baseUrl } = await startRememberApp({ cacheDir: null });
    const opts = await req(baseUrl, '/api/auth/options');
    assert.equal(opts.status, 200);
    assert.deepEqual(opts.data, { rememberMeAvailable: false });

    const jar = new CookieJar();
    const login = await req(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { Origin: baseUrl },
      jar,
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD, rememberMe: true },
    });
    assert.equal(login.status, 200);
    assert.ok(jar.get('joplin_web_session'));
    assert.equal(jar.get('joplin_web_remember'), undefined);
    assert.equal(login.headers.getSetCookie().some((c) => /joplin_web_remember=[^;]+/.test(c)), false);
  });

  test('API clients (no Origin) ignore rememberMe and receive no remember cookie', async () => {
    const { baseUrl, cacheDir } = await startRememberApp();
    const login = await req(baseUrl, '/api/auth/login', {
      method: 'POST',
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD, rememberMe: true },
    });
    assert.equal(login.status, 200);
    assert.ok(login.data.sessionId);
    assert.equal(login.headers.getSetCookie().some((c) => /joplin_web_remember=[^;]+/.test(c)), false);
    await assert.rejects(stat(path.join(cacheDir!, 'auth', 'remember.json')));
  });

  test('login with rememberMe sets httpOnly cookie, stores encrypted file (mode 0600, no plaintext password), and restores after 12h expiry', async () => {
    const { baseUrl, cacheDir } = await startRememberApp();
    const opts = await req(baseUrl, '/api/auth/options');
    assert.deepEqual(opts.data, { rememberMeAvailable: true });

    const jar = new CookieJar();
    const login = await req(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { Origin: baseUrl, 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/125.0' },
      jar,
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD, rememberMe: true },
    });
    assert.equal(login.status, 200);
    const setRemember = login.headers.getSetCookie().find((c) => /^joplin_web_remember=[^;]+/.test(c));
    assert.ok(setRemember, 'remember cookie set');
    assert.match(setRemember, /HttpOnly/i);
    assert.match(setRemember, /SameSite=Strict/i);
    assert.match(setRemember, /Path=\/api/i);
    assert.match(setRemember, /Max-Age=2592000/i);

    const rememberFile = path.join(cacheDir!, 'auth', 'remember.json');
    const fileStats = await stat(rememberFile);
    assert.equal(fileStats.mode & 0o777, 0o600);
    const rawDisk = await readFile(rememberFile, 'utf8');
    const cookieVal = jar.get('joplin_web_remember')!;
    const [, keyPart] = cookieVal.split('.');
    assert.equal(rawDisk.includes(`"password"`), false, 'no password key on disk');
    assert.equal(rawDisk.includes(`"${DEMO_PASSWORD}"`), false, 'no plaintext password on disk');
    assert.equal(rawDisk.includes(keyPart), false, 'split key K never stored on disk');

    const storedBefore = Object.values(JSON.parse(rawDisk) as Record<string, any>)[0];
    const originalSession = jar.get('joplin_web_session')!;
    assert.ok(mock.sessions.has(originalSession));

    // Simulate Joplin Server deleting the session after 12h + browser reopening with only remember cookie
    mock.sessions.delete(originalSession);
    jar.delete('joplin_web_session');

    const notes = await req(baseUrl, '/api/notes', { jar });
    assert.equal(notes.status, 200);
    assert.ok(Array.isArray(notes.data) && notes.data.length > 0);
    const restoredSession = jar.get('joplin_web_session');
    assert.ok(restoredSession && restoredSession !== originalSession, 'new session cookie issued');
    assert.ok(mock.sessions.has(restoredSession));

    const storedAfter = Object.values(JSON.parse(await readFile(rememberFile, 'utf8')) as Record<string, any>)[0];
    assert.equal(storedAfter.expiresAt, storedBefore.expiresAt, 'expiry is fixed, NOT sliding');
    assert.ok(storedAfter.lastUsedAt >= storedBefore.lastUsedAt);
  });

  test('uses __Host-joplin_web_remember when cookies are Secure', async () => {
    const { baseUrl } = await startRememberApp({ cookieSecure: true });
    const login = await req(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { Origin: baseUrl },
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD, rememberMe: true },
    });
    assert.equal(login.status, 200);
    const setRemember = login.headers.getSetCookie().find((c) => /^__Host-joplin_web_remember=[^;]+/.test(c));
    assert.ok(setRemember);
    assert.match(setRemember, /;\s*Secure/i);
    assert.match(setRemember, /Path=\/;/i);
    assert.match(setRemember, /SameSite=Strict/i);
  });

  test('mid-use expiry with a stale-but-cached session invalidates cache and restores on retry', async () => {
    const { baseUrl } = await startRememberApp({ authCacheTtlMs: 300_000 });
    const jar = new CookieJar();
    const login = await req(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { Origin: baseUrl },
      jar,
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD, rememberMe: true },
    });
    assert.equal(login.status, 200);
    const staleSession = jar.get('joplin_web_session')!;

    // Session is still cached valid in validationCache, but Joplin Server expired it
    mock.sessions.delete(staleSession);

    const first = await req(baseUrl, '/api/notes', { jar });
    assert.equal(first.status, 401);
    assert.equal(first.data.retryable, true, 'signals client to retry once without showing session-expired dialog');

    // Immediate retry hits authenticateSession (now invalidated) and restores a fresh session
    const retry = await req(baseUrl, '/api/notes', { jar });
    assert.equal(retry.status, 200);
    assert.ok(Array.isArray(retry.data) && retry.data.length > 0);
    const newSession = jar.get('joplin_web_session')!;
    assert.notEqual(newSession, staleSession);
  });

  test('parallel requests at expiry share a single upstream createSession call (single-flight)', async () => {
    const { baseUrl } = await startRememberApp();
    const jar = new CookieJar();
    const login = await req(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { Origin: baseUrl },
      jar,
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD, rememberMe: true },
    });
    assert.equal(login.status, 200);
    const oldSession = jar.get('joplin_web_session')!;
    const rememberVal = jar.get('joplin_web_remember')!;
    mock.sessions.delete(oldSession);

    let createCalls = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let enteredGate!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enteredGate = resolve;
    });

    mock.onCreateSession = async () => {
      createCalls += 1;
      if (createCalls === 1) {
        enteredGate();
        await gate;
      }
    };

    try {
      const cookieHeader = `joplin_web_remember=${rememberVal}`;
      const p1 = req(baseUrl, '/api/notes', { headers: { Cookie: cookieHeader } });
      await firstEntered;
      const p2 = req(baseUrl, '/api/notebooks', { headers: { Cookie: cookieHeader } });
      const p3 = req(baseUrl, '/api/tags', { headers: { Cookie: cookieHeader } });
      // Give p2/p3 a tick to join the single-flight map before releasing upstream
      await new Promise((resolve) => setTimeout(resolve, 30));
      releaseGate();

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      assert.equal(r1.status, 200);
      assert.equal(r2.status, 200);
      assert.equal(r3.status, 200);
      assert.equal(createCalls, 1, 'exactly one upstream createSession for parallel requests');

      const s1 = r1.headers.getSetCookie().find((c) => c.startsWith('joplin_web_session='))?.split(';')[0];
      const s2 = r2.headers.getSetCookie().find((c) => c.startsWith('joplin_web_session='))?.split(';')[0];
      const s3 = r3.headers.getSetCookie().find((c) => c.startsWith('joplin_web_session='))?.split(';')[0];
      assert.ok(s1 && s1 === s2 && s2 === s3, 'all parallel callers receive the same new session cookie');
    } finally {
      mock.onCreateSession = null;
    }
  });

  test('expired entry, tampered key, and unknown id clear the cookie, return 401, and never call Joplin Server', async () => {
    const { baseUrl, cacheDir } = await startRememberApp();
    const jar = new CookieJar();
    const login = await req(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { Origin: baseUrl },
      jar,
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD, rememberMe: true },
    });
    assert.equal(login.status, 200);
    const validCookie = jar.get('joplin_web_remember')!;
    const [idPart, keyPart] = validCookie.split('.');

    let createCalls = 0;
    mock.onCreateSession = () => {
      createCalls += 1;
    };

    try {
      // 1. Unknown id
      const unknownCookie = `${randomBytes(16).toString('base64url')}.${randomBytes(32).toString('base64url')}`;
      const unknownRes = await req(baseUrl, '/api/notes', {
        headers: { Cookie: `joplin_web_remember=${unknownCookie}` },
      });
      assert.equal(unknownRes.status, 401);
      assert.ok(unknownRes.headers.getSetCookie().some((c) => c.startsWith('joplin_web_remember=;')));

      // 2. Tampered key K (valid id, flipped byte in K)
      const badKey = Buffer.from(keyPart, 'base64url');
      badKey[0] ^= 0xff;
      const tamperedRes = await req(baseUrl, '/api/notes', {
        headers: { Cookie: `joplin_web_remember=${idPart}.${badKey.toString('base64url')}` },
      });
      assert.equal(tamperedRes.status, 401);
      assert.ok(tamperedRes.headers.getSetCookie().some((c) => c.startsWith('joplin_web_remember=;')));

      // 3. Expired entry on disk
      const rememberFile = path.join(cacheDir!, 'auth', 'remember.json');
      const entries = JSON.parse(await readFile(rememberFile, 'utf8')) as Record<string, any>;
      for (const hash of Object.keys(entries)) {
        entries[hash].expiresAt = Date.now() - 1000;
      }
      await writeFile(rememberFile, JSON.stringify(entries), { mode: 0o600 });

      const expiredRes = await req(baseUrl, '/api/notes', {
        headers: { Cookie: `joplin_web_remember=${validCookie}` },
      });
      assert.equal(expiredRes.status, 401);
      assert.ok(expiredRes.headers.getSetCookie().some((c) => c.startsWith('joplin_web_remember=;')));
      assert.equal(createCalls, 0, 'no upstream createSession calls for unknown, tampered, or expired cookies');
    } finally {
      mock.onCreateSession = null;
    }
  });

  test('password change on mock deletes the entry and clears the cookie; JoplinConnectionError returns 503 and keeps entry', async () => {
    const { baseUrl, cacheDir } = await startRememberApp();
    const jar = new CookieJar();
    await req(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { Origin: baseUrl },
      jar,
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD, rememberMe: true },
    });
    const rememberVal = jar.get('joplin_web_remember')!;
    const rememberFile = path.join(cacheDir!, 'auth', 'remember.json');

    // Simulate upstream unreachable -> 503 and entry kept
    const { joplinApi, JoplinConnectionError } = await import('../src/services/joplin-api.js');
    const stub = testMock.method(joplinApi, 'createSession', async () => {
      throw new JoplinConnectionError('unreachable');
    });
    try {
      const outage = await req(baseUrl, '/api/notes', {
        headers: { Cookie: `joplin_web_remember=${rememberVal}` },
      });
      assert.equal(outage.status, 503);
      assert.equal(outage.headers.getSetCookie().some((c) => c.startsWith('joplin_web_remember=;')), false);
      const stillThere = JSON.parse(await readFile(rememberFile, 'utf8')) as Record<string, unknown>;
      assert.equal(Object.keys(stillThere).length, 1);
    } finally {
      stub.mock.restore();
    }

    // Simulate password change -> 401, cookie cleared, entry deleted
    mock.setPassword('changed-password');
    try {
      const changed = await req(baseUrl, '/api/notes', {
        headers: { Cookie: `joplin_web_remember=${rememberVal}` },
      });
      assert.equal(changed.status, 401);
      assert.ok(changed.headers.getSetCookie().some((c) => c.startsWith('joplin_web_remember=;')));
      const remaining = JSON.parse(await readFile(rememberFile, 'utf8')) as Record<string, unknown>;
      assert.equal(Object.keys(remaining).length, 0, 'entry deleted on JoplinAuthError');
    } finally {
      mock.setPassword(DEMO_PASSWORD);
    }
  });

  test('logout revokes the entry for this cookie and clears it', async () => {
    const { baseUrl } = await startRememberApp();
    const jar = new CookieJar();
    await req(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { Origin: baseUrl },
      jar,
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD, rememberMe: true },
    });
    const rememberVal = jar.get('joplin_web_remember')!;
    const logout = await req(baseUrl, '/api/auth/logout', {
      method: 'POST',
      headers: { Origin: baseUrl },
      jar,
    });
    assert.equal(logout.status, 200);
    assert.equal(jar.get('joplin_web_remember'), undefined);

    // Replaying the old remember cookie must fail
    const replay = await req(baseUrl, '/api/notes', {
      headers: { Cookie: `joplin_web_remember=${rememberVal}` },
    });
    assert.equal(replay.status, 401);
  });

  test('2FA (TOTP and recovery) persists remember entry only after verification, restored session requires step-up, and revoke-all/factor changes clear entries', async () => {
    const { computeTotp } = await import('../src/services/totp.js');
    const { baseUrl, cacheDir } = await startRememberApp();
    const rememberFile = path.join(cacheDir!, 'auth', 'remember.json');

    // First sign in normally and enroll TOTP (with recovery codes)
    const setupJar = new CookieJar();
    await req(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { Origin: baseUrl },
      jar: setupJar,
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD, rememberMe: true },
    });
    assert.equal(Object.keys(JSON.parse(await readFile(rememberFile, 'utf8'))).length, 1);

    const totpSetup = await req(baseUrl, '/api/auth/2fa/totp/setup', {
      method: 'POST',
      headers: { Origin: baseUrl },
      jar: setupJar,
      json: {},
    });
    assert.equal(totpSetup.status, 200);
    const secret = totpSetup.data.secret as string;
    const baseTime = Date.now();
    const confirm = await req(baseUrl, '/api/auth/2fa/totp/confirm', {
      method: 'POST',
      headers: { Origin: baseUrl },
      jar: setupJar,
      json: { code: computeTotp(secret, baseTime - 30_000) },
    });
    assert.equal(confirm.status, 200);
    const recoveryCodes = confirm.data.recoveryCodes as string[];
    // First-factor enrollment must revoke prior remember entries
    assert.equal(Object.keys(JSON.parse(await readFile(rememberFile, 'utf8'))).length, 0);

    // Login with TOTP + rememberMe: must NOT persist before TOTP verification
    const totpJar = new CookieJar();
    const login1 = await req(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { Origin: baseUrl, 'User-Agent': 'Firefox/130.0 (Macintosh)' },
      jar: totpJar,
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD, rememberMe: true },
    });
    assert.equal(login1.status, 200);
    assert.equal(login1.data.twoFactor.required, true);
    assert.equal(totpJar.get('joplin_web_remember'), undefined);
    assert.equal(Object.keys(JSON.parse(await readFile(rememberFile, 'utf8'))).length, 0);

    const verify1 = await req(baseUrl, '/api/auth/2fa/totp/verify', {
      method: 'POST',
      headers: { Origin: baseUrl },
      jar: totpJar,
      json: { code: computeTotp(secret, baseTime) },
    });
    assert.equal(verify1.status, 200);
    assert.ok(totpJar.get('joplin_web_remember'), 'remember cookie issued after TOTP verification');
    assert.equal(Object.keys(JSON.parse(await readFile(rememberFile, 'utf8'))).length, 1);

    // Login with recovery code + rememberMe: persists only after recovery verification
    const recJar = new CookieJar();
    const login2 = await req(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { Origin: baseUrl, 'User-Agent': 'Chrome/130.0 (Windows NT 10.0)' },
      jar: recJar,
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD, rememberMe: true },
    });
    assert.equal(login2.status, 200);
    assert.equal(Object.keys(JSON.parse(await readFile(rememberFile, 'utf8'))).length, 1);

    const verify2 = await req(baseUrl, '/api/auth/2fa/recovery/verify', {
      method: 'POST',
      headers: { Origin: baseUrl },
      jar: recJar,
      json: { code: recoveryCodes[0] },
    });
    assert.equal(verify2.status, 200);
    assert.ok(recJar.get('joplin_web_remember'), 'remember cookie issued after recovery verification');
    assert.equal(Object.keys(JSON.parse(await readFile(rememberFile, 'utf8'))).length, 2);

    // Restore via remember cookie -> restored session has lastSecondFactorAt: null (step-up required!)
    mock.sessions.delete(totpJar.get('joplin_web_session')!);
    totpJar.delete('joplin_web_session');
    const restoredList = await req(baseUrl, '/api/auth/remembered', { jar: totpJar });
    assert.equal(restoredList.status, 200);
    assert.equal(restoredList.data.entries.length, 2);
    assert.equal(restoredList.data.entries.filter((e: any) => e.current).length, 1);

    // Attempt to revoke all without step-up -> 403 stepUpRequired
    const noStepUp = await req(baseUrl, '/api/auth/remembered', {
      method: 'DELETE',
      headers: { Origin: baseUrl },
      jar: totpJar,
    });
    assert.equal(noStepUp.status, 403);
    assert.equal(noStepUp.data.stepUpRequired, true);

    // Complete step-up with a recovery code, then revoke one entry
    const stepUp = await req(baseUrl, '/api/auth/2fa/step-up/recovery', {
      method: 'POST',
      headers: { Origin: baseUrl },
      jar: totpJar,
      json: { code: recoveryCodes[1] },
    });
    assert.equal(stepUp.status, 200);

    const otherEntry = restoredList.data.entries.find((e: any) => !e.current);
    const revokeOne = await req(baseUrl, `/api/auth/remembered/${otherEntry.id}`, {
      method: 'DELETE',
      headers: { Origin: baseUrl },
      jar: totpJar,
    });
    assert.equal(revokeOne.status, 200);
    assert.equal(Object.keys(JSON.parse(await readFile(rememberFile, 'utf8'))).length, 1);

    // Revoke all trusted devices ("forget all devices") must also revoke all remember entries
    const forgetAll = await req(baseUrl, '/api/auth/2fa/trusted-devices', {
      method: 'DELETE',
      headers: { Origin: baseUrl },
      jar: totpJar,
    });
    assert.equal(forgetAll.status, 200);
    assert.equal(Object.keys(JSON.parse(await readFile(rememberFile, 'utf8'))).length, 0);

    // Re-create a remember entry, then remove TOTP -> must delete all remember entries
    const login3Jar = new CookieJar();
    await req(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { Origin: baseUrl },
      jar: login3Jar,
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD, rememberMe: true },
    });
    await req(baseUrl, '/api/auth/2fa/recovery/verify', {
      method: 'POST',
      headers: { Origin: baseUrl },
      jar: login3Jar,
      json: { code: recoveryCodes[2] },
    });
    assert.equal(Object.keys(JSON.parse(await readFile(rememberFile, 'utf8'))).length, 1);

    const removeTotp = await req(baseUrl, '/api/auth/2fa/totp', {
      method: 'DELETE',
      headers: { Origin: baseUrl },
      jar: totpJar,
    });
    assert.equal(removeTotp.status, 200);
    assert.equal(Object.keys(JSON.parse(await readFile(rememberFile, 'utf8'))).length, 0);
  });

  test('caps remembered entries per user at 20 (dropping oldest) and prunes expired on write', async () => {
    const { baseUrl, cacheDir } = await startRememberApp();
    const rememberFile = path.join(cacheDir!, 'auth', 'remember.json');
    const cookies: string[] = [];
    for (let i = 0; i < 22; i++) {
      const jar = new CookieJar();
      const res = await req(baseUrl, '/api/auth/login', {
        method: 'POST',
        headers: { Origin: baseUrl },
        jar,
        json: { email: DEMO_EMAIL, password: DEMO_PASSWORD, rememberMe: true },
      });
      assert.equal(res.status, 200);
      cookies.push(jar.get('joplin_web_remember')!);
    }
    const entries = JSON.parse(await readFile(rememberFile, 'utf8')) as Record<string, unknown>;
    assert.equal(Object.keys(entries).length, 20);
    // Oldest entry (index 0) was dropped, newest (index 21) still restores
    const oldest = await req(baseUrl, '/api/notes', { headers: { Cookie: `joplin_web_remember=${cookies[0]}` } });
    assert.equal(oldest.status, 401);
    const newest = await req(baseUrl, '/api/notes', { headers: { Cookie: `joplin_web_remember=${cookies[21]}` } });
    assert.equal(newest.status, 200);
  });
});
