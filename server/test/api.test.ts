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

describe('logout', () => {
  test('logs out', async () => {
    assert.equal((await api('/api/auth/logout', { method: 'POST' })).status, 200);
  });
});
