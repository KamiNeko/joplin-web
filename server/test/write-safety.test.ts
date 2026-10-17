import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import {
  startMockJoplinServer,
  syncTargetInfoItem,
  type MockJoplinServer,
} from '../demo/mock-joplin-server.js';
import { buildDemoItems, DEMO_EMAIL, DEMO_PASSWORD, demoId } from '../demo/seed.js';
import { deserialize, serialize } from '../src/services/serializer.js';
import { JoplinItemType } from '../src/types/index.js';

/**
 * Data-safety tests for the write paths (#30, #45, #46, #47, #48), run through the HTTP API
 * against the in-memory mock Joplin Server. Items are also edited directly in `mock.items` to
 * simulate other Joplin clients syncing the same account.
 *
 * The cache TTL is long here, so stale-cache situations are real: tests that change
 * `mock.items` behind the backend's back call `refresh()` when they want the cache to see it.
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

async function api(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (session) headers.set('Authorization', `Bearer ${session}`);
  if (init.body && typeof init.body === 'string') headers.set('Content-Type', 'application/json');
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const text = await res.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // plain text response
  }
  return { status: res.status, data };
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});

const refresh = async () => assert.equal((await api('/api/notebooks/refresh', { method: 'POST' })).status, 200);

let clock = Date.now() + 60_000;

/** Stores a raw item in the mock, the way another client's upload would */
function putRaw(id: string, content: string): void {
  mock.items.set(`${id}.md`, {
    content: Buffer.from(content, 'utf8'),
    contentType: 'text/plain; charset=utf-8',
    updatedTime: ++clock,
  });
}

/** Builds and stores an item from properties (as another Joplin client would write it) */
function putItem(
  type: JoplinItemType,
  id: string,
  title: string,
  body: string,
  properties: Record<string, string>
): void {
  putRaw(id, serialize({ type_: type, title, body, properties: { id, ...properties } }));
}

function rawOf(id: string): string | undefined {
  return mock.items.get(`${id}.md`)?.content.toString('utf8');
}

function itemOf(id: string) {
  const raw = rawOf(id);
  assert.ok(raw, `item ${id} exists on the mock`);
  return deserialize(raw, `${id}.md`);
}

/** Changes properties of an item directly on the mock (another client's edit) */
function editOnServer(id: string, changes: Record<string, string>): void {
  const item = itemOf(id);
  putRaw(id, serialize({ type_: item.type_, title: item.title, body: item.body, properties: { ...item.properties, ...changes } }));
}

/** Snapshot of every item's content, to prove a refused request wrote nothing */
function snapshot(): Map<string, string> {
  return new Map([...mock.items].map(([name, item]) => [name, item.content.toString('base64')]));
}

function hexId(seed: string): string {
  return demoId(`write-safety:${seed}`);
}

const ENCRYPTED = {
  encryption_applied: '1',
  encryption_cipher_text: 'JED01000022abcdef0123456789',
  master_key_id: '0123456789abcdef0123456789abcdef',
};

async function createNotebook(title: string, parentId = '') {
  const res = await api('/api/notebooks', json('POST', { title, parentId }));
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data.id as string;
}

async function createNote(parentId: string, title = 'note', body = 'body') {
  const res = await api('/api/notes', json('POST', { title, body, parentId }));
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data.id as string;
}

before(async () => {
  mock = await startMockJoplinServer({ email: DEMO_EMAIL, password: DEMO_PASSWORD, items: buildDemoItems(), pageSize: 9 });
  const port = await freePort();
  // Must be set before the backend's config module is loaded
  process.env.JOPLIN_SERVER_URL = mock.url;
  process.env.PORT = String(port);
  process.env.CACHE_TTL_MS = '600000';
  baseUrl = `http://127.0.0.1:${port}`;
  ({ server } = await import('../src/index.js'));
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));

  const login = await api('/api/auth/login', json('POST', { email: DEMO_EMAIL, password: DEMO_PASSWORD }));
  assert.equal(login.status, 200);
  session = login.data.sessionId;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await mock.close();
});

describe('permanent deletion of notes (#45)', () => {
  test('refuses to purge a notebook through the notes endpoint', async () => {
    const nb = await createNotebook('Live notebook');
    const child = await createNote(nb, 'child');
    const res = await api(`/api/notes/${nb}?permanent=true`, { method: 'DELETE' });
    assert.equal(res.status, 404);
    assert.ok(mock.items.has(`${nb}.md`), 'notebook still on the server');
    assert.ok(mock.items.has(`${child}.md`), 'child note still on the server');
  });

  test('refuses to purge a tag through the notes endpoint', async () => {
    const tagId = demoId('tag-planning');
    const res = await api(`/api/notes/${tagId}?permanent=true`, { method: 'DELETE' });
    assert.equal(res.status, 404);
    assert.ok(mock.items.has(`${tagId}.md`));
  });

  test('refuses to purge a note that is not in the trash', async () => {
    const nb = await createNotebook('Purge guard');
    const note = await createNote(nb, 'live');
    const res = await api(`/api/notes/${note}?permanent=true`, { method: 'DELETE' });
    assert.equal(res.status, 409);
    assert.ok(mock.items.has(`${note}.md`));
  });

  test('refuses to purge a trashed note that another client restored meanwhile', async () => {
    const nb = await createNotebook('Restored elsewhere');
    const note = await createNote(nb, 'restored on desktop');
    assert.equal((await api(`/api/notes/${note}`, { method: 'DELETE' })).status, 204);
    editOnServer(note, { deleted_time: '0' }); // the cache still says "trashed"
    const res = await api(`/api/notes/${note}?permanent=true`, { method: 'DELETE' });
    assert.equal(res.status, 409);
    assert.ok(mock.items.has(`${note}.md`));
  });

  test('purges a trashed note together with its note-tag links', async () => {
    const nb = await createNotebook('Purge ok');
    const note = await createNote(nb, 'to purge');
    assert.equal((await api(`/api/notes/${note}/tags`, json('POST', { title: 'purge-tag' }))).status, 200);
    const links = [...mock.items.entries()]
      .filter(([, item]) => item.content.toString('utf8').includes(`note_id: ${note}`))
      .map(([name]) => name);
    assert.equal(links.length, 1);

    assert.equal((await api(`/api/notes/${note}`, { method: 'DELETE' })).status, 204);
    assert.equal((await api(`/api/notes/${note}?permanent=true`, { method: 'DELETE' })).status, 204);
    assert.ok(!mock.items.has(`${note}.md`));
    assert.ok(!mock.items.has(links[0]), 'note-tag link deleted too');
  });

  test('purges a note whose notebook is in the trash', async () => {
    const nb = await createNotebook('Trashed parent');
    const note = await createNote(nb, 'inside trashed notebook');
    editOnServer(nb, { deleted_time: String(Date.now()) });
    assert.equal((await api(`/api/notes/${note}?permanent=true`, { method: 'DELETE' })).status, 204);
    assert.ok(!mock.items.has(`${note}.md`));
  });

  test('treats a note already deleted on the server as purged', async () => {
    const nb = await createNotebook('Already gone');
    const note = await createNote(nb, 'gone');
    mock.items.delete(`${note}.md`);
    assert.equal((await api(`/api/notes/${note}?permanent=true`, { method: 'DELETE' })).status, 204);
    assert.equal((await api(`/api/notes/${note}`)).status, 404);
  });
});

describe('permanent deletion of notebooks (#45)', () => {
  test('keeps notes that another client moved out after the cache was filled', async () => {
    const trashed = await createNotebook('Trashed A');
    const other = await createNotebook('Live B');
    const stays = await createNote(trashed, 'stays in A');
    const movedOut = await createNote(trashed, 'moved to B');
    assert.equal((await api(`/api/notebooks/${trashed}`, { method: 'DELETE' })).status, 200);

    // Desktop restores the note and moves it to B. The cache still lists it under A.
    editOnServer(movedOut, { deleted_time: '0', parent_id: other });

    const res = await api(`/api/notebooks/${trashed}?permanent=true`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { notebooks: 1, notes: 1 });
    assert.ok(!mock.items.has(`${trashed}.md`));
    assert.ok(!mock.items.has(`${stays}.md`));
    assert.ok(mock.items.has(`${movedOut}.md`), 'moved note survives');
    assert.equal(itemOf(movedOut).parentId, other);
  });

  test('also purges notes moved into the trashed notebook since the last refresh', async () => {
    const trashed = await createNotebook('Trashed C');
    const note = await createNote(trashed, 'original');
    assert.equal((await api(`/api/notebooks/${trashed}`, { method: 'DELETE' })).status, 200);
    const arrived = hexId('arrived-in-c');
    putItem(JoplinItemType.Note, arrived, 'arrived', 'x', { parent_id: trashed, deleted_time: '0', updated_time: new Date().toISOString() });

    const res = await api(`/api/notebooks/${trashed}?permanent=true`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.ok(!mock.items.has(`${note}.md`));
    assert.ok(!mock.items.has(`${arrived}.md`), 'no orphan left behind');
  });

  test('refuses to purge a notebook that is not in the trash', async () => {
    const nb = await createNotebook('Not trashed');
    assert.equal((await api(`/api/notebooks/${nb}?permanent=true`, { method: 'DELETE' })).status, 409);
    assert.ok(mock.items.has(`${nb}.md`));
  });
});

describe('cache ghosts (#46)', () => {
  test('a note written by Joplin Web and deleted elsewhere disappears on refresh', async () => {
    const nb = await createNotebook('Ghosts');
    const note = await createNote(nb, 'ghost');
    mock.items.delete(`${note}.md`); // another client purges it
    await refresh();
    assert.equal((await api(`/api/notes/${note}`)).status, 404);
    const listed = await api(`/api/notes?notebook_id=${nb}`);
    assert.ok(!listed.data.some((n: any) => n.id === note));
  });

  test('a trashed note purged elsewhere leaves the trash list', async () => {
    const nb = await createNotebook('Ghost trash');
    const note = await createNote(nb, 'emptied on desktop');
    assert.equal((await api(`/api/notes/${note}`, { method: 'DELETE' })).status, 204);
    mock.items.delete(`${note}.md`);
    await refresh();
    const trash = await api('/api/notes?is_trash=true');
    assert.ok(!trash.data.some((n: any) => n.id === note));
  });

  test('tags and note-tag links deleted elsewhere disappear on refresh', async () => {
    const nb = await createNotebook('Ghost tags');
    const note = await createNote(nb, 'tagged');
    const tagged = await api(`/api/notes/${note}/tags`, json('POST', { title: 'ghost-tag' }));
    const tag = tagged.data.tags.find((t: any) => t.title === 'ghost-tag');
    const linkName = [...mock.items.entries()].find(([, item]) =>
      item.content.toString('utf8').includes(`tag_id: ${tag.id}`)
    )![0];
    mock.items.delete(linkName);
    mock.items.delete(`${tag.id}.md`);
    await refresh();
    assert.deepEqual((await api(`/api/notes/${note}`)).data.tags, []);
    assert.ok(!(await api('/api/tags')).data.some((t: any) => t.id === tag.id));
  });

  test('items written by Joplin Web are re-read and kept when still on the server', async () => {
    const nb = await createNotebook('Kept');
    const note = await createNote(nb, 'kept');
    await refresh();
    assert.equal((await api(`/api/notes/${note}`)).status, 200);
  });
});

describe('carriage returns in note bodies (#47)', () => {
  const nb = demoId('nb-reading');
  const body = '# Pasted from Windows\r\n\r\n- one\r\n- two\r\n';

  function seedCrlfNote(key: string): string {
    const id = hexId(key);
    putItem(JoplinItemType.Note, id, 'CRLF note', body, {
      parent_id: nb,
      created_time: '2026-10-01T10:00:00.000Z',
      updated_time: '2026-10-01T10:00:00.000Z',
      is_todo: '1',
      todo_completed: '0',
      deleted_time: '0',
      encryption_applied: '0',
    });
    return id;
  }

  const textSection = (raw: string) => raw.slice(0, raw.lastIndexOf('\n\nid: '));

  test('moving a note keeps its body byte-identical', async () => {
    const id = seedCrlfNote('crlf-move');
    await refresh();
    const before = rawOf(id)!;
    const res = await api(`/api/notes/${id}`, json('PUT', { parentId: demoId('nb-travel') }));
    assert.equal(res.status, 200);
    const afterRaw = rawOf(id)!;
    assert.equal(textSection(afterRaw), textSection(before));
    assert.equal(itemOf(id).body, body);
  });

  test('trashing, restoring and completing a to-do keep the body byte-identical', async () => {
    const id = seedCrlfNote('crlf-trash');
    await refresh();
    const before = textSection(rawOf(id)!);
    assert.equal((await api(`/api/notes/${id}`, json('PUT', { todoCompleted: true }))).status, 200);
    assert.equal(textSection(rawOf(id)!), before);
    assert.equal((await api(`/api/notes/${id}`, { method: 'DELETE' })).status, 204);
    assert.equal(textSection(rawOf(id)!), before);
    assert.equal((await api(`/api/notes/${id}/restore`, { method: 'POST' })).status, 200);
    assert.equal(textSection(rawOf(id)!), before);
  });

  test('the API returns the body with its CRLF line endings', async () => {
    const id = seedCrlfNote('crlf-read');
    await refresh();
    assert.equal((await api(`/api/notes/${id}`)).data.body, body);
  });
});

describe('end-to-end encrypted accounts (#48)', () => {
  test('refuses every write while info.json says E2EE is enabled', async () => {
    const nb = await createNotebook('Before E2EE');
    const note = await createNote(nb, 'before e2ee');
    mock.items.set('info.json', syncTargetInfoItem(true));
    try {
      const before = snapshot();
      const attempts = [
        await api('/api/notes', json('POST', { title: 'plain', body: 'leak', parentId: nb })),
        await api(`/api/notes/${note}`, json('PUT', { body: 'leak' })),
        await api(`/api/notes/${note}`, { method: 'DELETE' }),
        await api(`/api/notes/${note}/tags`, json('POST', { title: 'secret' })),
        await api('/api/notebooks', json('POST', { title: 'plain notebook' })),
        await api(`/api/notebooks/${nb}`, json('PUT', { title: 'renamed' })),
        await api(`/api/notebooks/${nb}`, { method: 'DELETE' }),
        await api(`/api/tags/${demoId('tag-ideas')}`, json('PUT', { title: 'renamed-tag' })),
      ];
      for (const res of attempts) {
        assert.equal(res.status, 422, JSON.stringify(res.data));
        assert.match(res.data.error, /end-to-end encryption/);
      }
      assert.deepEqual(snapshot(), before, 'nothing was written');
      // Reading still works
      assert.equal((await api(`/api/notes/${note}`)).status, 200);
    } finally {
      mock.items.delete('info.json');
    }
  });

  test('allows writes when info.json says E2EE is disabled', async () => {
    mock.items.set('info.json', syncTargetInfoItem(false));
    try {
      const nb = await createNotebook('E2EE off');
      await createNote(nb, 'fine');
    } finally {
      mock.items.delete('info.json');
    }
  });

  test('fails closed when info.json cannot be parsed', async () => {
    mock.items.set('info.json', { content: Buffer.from('{not json'), contentType: 'application/json', updatedTime: ++clock });
    try {
      const res = await api('/api/notebooks', json('POST', { title: 'unknown state' }));
      assert.equal(res.status, 422);
    } finally {
      mock.items.delete('info.json');
    }
  });

  test('refuses to create a note in an encrypted notebook', async () => {
    const nb = hexId('encrypted-notebook');
    putItem(JoplinItemType.Folder, nb, '', '', { parent_id: '', deleted_time: '0', ...ENCRYPTED });
    await refresh();
    const before = snapshot();
    const res = await api('/api/notes', json('POST', { title: 'plain', body: 'leak', parentId: nb }));
    assert.equal(res.status, 422);
    assert.deepEqual(snapshot(), before);

    const sub = await api('/api/notebooks', json('POST', { title: 'plain sub', parentId: nb }));
    assert.equal(sub.status, 422);

    const plain = await createNote(demoId('nb-reading'), 'plain');
    const move = await api(`/api/notes/${plain}`, json('PUT', { parentId: nb }));
    assert.equal(move.status, 422);
    assert.equal(itemOf(plain).parentId, demoId('nb-reading'));
  });

  test('trashing a notebook with one encrypted note changes nothing', async () => {
    const nb = await createNotebook('Mixed');
    const sub = await createNotebook('Mixed child', nb);
    const plainA = await createNote(nb, 'plain a');
    const plainB = await createNote(sub, 'plain b');
    const encrypted = hexId('encrypted-in-mixed');
    putItem(JoplinItemType.Note, encrypted, '', '', { parent_id: sub, deleted_time: '0', ...ENCRYPTED });
    await refresh();

    const before = snapshot();
    const res = await api(`/api/notebooks/${nb}`, { method: 'DELETE' });
    assert.equal(res.status, 422);
    assert.deepEqual(snapshot(), before, 'no note or notebook was trashed');
    for (const id of [nb, sub, plainA, plainB]) assert.equal(itemOf(id).deletedTime, 0);
  });

  test('encrypted notes refuse edits, trash, restore and tags but can be read', async () => {
    const id = hexId('encrypted-note');
    putItem(JoplinItemType.Note, id, '', '', { parent_id: demoId('nb-reading'), deleted_time: '0', ...ENCRYPTED });
    await refresh();
    const before = snapshot();
    assert.equal((await api(`/api/notes/${id}`, json('PUT', { body: 'x' }))).status, 422);
    assert.equal((await api(`/api/notes/${id}`, { method: 'DELETE' })).status, 422);
    assert.equal((await api(`/api/notes/${id}/restore`, { method: 'POST' })).status, 422);
    assert.equal((await api(`/api/notes/${id}/tags`, json('POST', { title: 'x' }))).status, 422);
    assert.deepEqual(snapshot(), before);

    assert.ok((await api(`/api/notes/${id}`)).status < 500);
    assert.equal((await api(`/api/notes?notebook_id=${demoId('nb-reading')}`)).status, 200);
  });

  test('refuses to link a note to an encrypted tag', async () => {
    const tagId = hexId('encrypted-tag');
    // Real encrypted tags have no cleartext title; a stale one could still match by title
    putItem(JoplinItemType.Tag, tagId, 'locked', '', ENCRYPTED);
    await refresh();
    const note = await createNote(demoId('nb-reading'), 'tag target');
    const before = snapshot();
    const res = await api(`/api/notes/${note}/tags`, json('POST', { title: 'locked' }));
    assert.equal(res.status, 422);
    assert.deepEqual(snapshot(), before);
  });
});

describe('write rules (#30)', () => {
  test('unknown properties survive update, trash and restore', async () => {
    const id = hexId('custom-props');
    putItem(JoplinItemType.Note, id, 'Custom', 'original', {
      parent_id: demoId('nb-reading'),
      created_time: '2026-10-01T10:00:00.000Z',
      updated_time: '2026-10-01T10:00:00.000Z',
      user_updated_time: '2026-10-01T10:00:00.000Z',
      deleted_time: '0',
      custom_field: 'keep me',
      source_application: 'net.cozic.joplin-desktop',
    });
    await refresh();
    const original = itemOf(id).properties;

    assert.equal((await api(`/api/notes/${id}`, json('PUT', { title: 'Custom 2', body: 'edited' }))).status, 200);
    assert.equal((await api(`/api/notes/${id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await api(`/api/notes/${id}/restore`, { method: 'POST' })).status, 200);

    const final = itemOf(id);
    assert.equal(final.title, 'Custom 2');
    assert.equal(final.body, 'edited');
    const changed = Object.keys({ ...original, ...final.properties }).filter(
      (key) => original[key] !== final.properties[key]
    );
    assert.deepEqual(changed.sort(), ['updated_time', 'user_updated_time']);
  });

  test('PUT on a notebook id through the notes endpoint is refused', async () => {
    const nb = demoId('nb-travel');
    const before = rawOf(nb);
    assert.equal((await api(`/api/notes/${nb}`, json('PUT', { body: 'x' }))).status, 404);
    assert.equal(rawOf(nb), before);
  });

  test('creating or moving into a trashed or unknown notebook is refused', async () => {
    const nb = await createNotebook('Soon trashed');
    assert.equal((await api(`/api/notebooks/${nb}`, { method: 'DELETE' })).status, 200);
    assert.equal((await api('/api/notes', json('POST', { title: 'x', parentId: nb }))).status, 404);
    assert.equal((await api('/api/notes', json('POST', { title: 'x', parentId: hexId('missing') }))).status, 404);
    assert.equal((await api('/api/notes', json('POST', { title: 'x' }))).status, 400);

    const note = await createNote(demoId('nb-reading'), 'mover');
    assert.equal((await api(`/api/notes/${note}`, json('PUT', { parentId: nb }))).status, 404);
  });

  test('tagging a trashed note is refused and writes nothing (#53)', async () => {
    const before = snapshot();
    const res = await api(`/api/notes/${demoId('note-old-draft')}/tags`, json('POST', { title: 'x-trashed' }));
    assert.equal(res.status, 404);
    assert.deepEqual(snapshot(), before);
  });

  test('tagging a note inside a trashed notebook is refused (#53)', async () => {
    const nb = await createNotebook('Trashed for tags');
    const note = await createNote(nb, 'in trashed notebook');
    editOnServer(nb, { deleted_time: String(Date.now()) });
    const before = snapshot();
    assert.equal((await api(`/api/notes/${note}/tags`, json('POST', { title: 'x-trashed-parent' }))).status, 404);
    assert.deepEqual(snapshot(), before);
  });

  test('a notebook trashed elsewhere is refused even while the cache still shows it', async () => {
    const nb = await createNotebook('Trashed on desktop');
    editOnServer(nb, { deleted_time: String(Date.now()) });
    assert.equal((await api('/api/notes', json('POST', { title: 'x', parentId: nb }))).status, 404);
  });
});
