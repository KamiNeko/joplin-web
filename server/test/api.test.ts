import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { startMockJoplinServer, type MockJoplinServer } from '../demo/mock-joplin-server.js';
import { buildDemoItems, DEMO_EMAIL, DEMO_PASSWORD, demoId } from '../demo/seed.js';

/**
 * End-to-end tests of the Express API against the in-memory mock Joplin Server (no network access).
 */

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

let mock: MockJoplinServer;
let server: Server;
let baseUrl: string;
let session: string;

async function api(path: string, init: RequestInit = {}, auth = true) {
  const headers = new Headers(init.headers);
  if (auth && session) headers.set('Authorization', `Bearer ${session}`);
  if (init.body && typeof init.body === 'string') headers.set('Content-Type', 'application/json');
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const text = await res.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // binary or plain text response
  }
  return { status: res.status, data, headers: res.headers };
}

before(async () => {
  mock = await startMockJoplinServer({ email: DEMO_EMAIL, password: DEMO_PASSWORD, items: buildDemoItems(), pageSize: 7 });
  const port = await freePort();
  // Must be set before the backend's config module is loaded
  process.env.JOPLIN_SERVER_URL = mock.url;
  process.env.PORT = String(port);
  process.env.CACHE_TTL_MS = '0';
  baseUrl = `http://127.0.0.1:${port}`;
  ({ server } = await import('../src/index.js'));
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await mock.close();
});

describe('auth', () => {
  test('health check is public', async () => {
    const res = await api('/api/health', {}, false);
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'ok');
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
    session = res.data.sessionId;
    assert.equal((await api('/api/auth/check')).status, 200);
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

  test('returns note details with tags', async () => {
    const res = await api(`/api/notes/${demoId('note-roadmap')}`);
    assert.equal(res.status, 200);
    assert.match(res.data.body, /## Goals/);
    assert.deepEqual(res.data.tags.map((t: any) => t.title).sort(), ['important', 'planning']);
    assert.equal(res.data.notebookTitle, 'Projects');
  });

  test('searches titles and bodies', async () => {
    const res = await api('/api/search?q=miso');
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.map((n: any) => n.title), ['Weeknight Miso Ramen']);
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
      body: JSON.stringify({ body: 'Changed', baseUpdatedTime: updatedTime }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.body, 'Changed');
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
    assert.equal((await api(`/api/notes/${noteId}?permanent=true`, { method: 'DELETE' })).status, 204);
    assert.ok(!mock.items.has(`${noteId}.md`));
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
});

describe('logout', () => {
  test('logs out', async () => {
    assert.equal((await api('/api/auth/logout', { method: 'POST' })).status, 200);
  });
});
