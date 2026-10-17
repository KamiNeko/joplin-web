import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { MockJoplinServer } from '../demo/mock-joplin-server.js';
import { buildDemoItems, demoId } from '../demo/seed.js';
import { serialize } from '../src/services/serializer.js';
import { JoplinItemType } from '../src/types/index.js';
import { mockItem, mockItemsOfType, putMockItem, startTestApp, type TestApp } from './helpers.js';

/**
 * Notebook endpoints (create, rename, move, trash, purge, refresh) against the mock Joplin Server.
 *
 * Runs with a long cache TTL, so reads are served from the backend cache and only writes and
 * POST /api/notebooks/refresh touch the cache. That makes cache updates after writes observable.
 */

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();

/** A folder written by "another Joplin client" with properties Joplin Web doesn't know about */
const LEGACY_ID = demoId('nb-legacy');
const LEGACY_ICON = '{"emoji":"📦","name":"package","type":1}';
/** A notebook already in the trash */
const TRASHED_ID = demoId('nb-trashed');
/** An end-to-end encrypted notebook */
const ENCRYPTED_ID = demoId('nb-encrypted');
const UNKNOWN_ID = 'f'.repeat(32);

function seedItems() {
  const items = buildDemoItems(NOW);
  const put = (id: string, content: string) =>
    items.set(`${id}.md`, { content: Buffer.from(content, 'utf8'), contentType: 'text/plain; charset=utf-8', updatedTime: NOW - HOUR });
  put(
    LEGACY_ID,
    serialize({
      type_: JoplinItemType.Folder,
      id: LEGACY_ID,
      title: 'Legacy',
      parentId: '',
      createdTime: NOW - 100 * HOUR,
      updatedTime: NOW - 100 * HOUR,
      properties: {
        deleted_time: '0',
        encryption_applied: '0',
        icon: LEGACY_ICON,
        share_id: 'abc',
        x_future_property: 'keep: me\nplease',
      },
    })
  );
  put(
    TRASHED_ID,
    serialize({
      type_: JoplinItemType.Folder,
      id: TRASHED_ID,
      title: 'Trashed notebook',
      parentId: '',
      createdTime: NOW - 100 * HOUR,
      updatedTime: NOW - 10 * HOUR,
      properties: { deleted_time: String(NOW - 10 * HOUR), encryption_applied: '0' },
    })
  );
  put(
    ENCRYPTED_ID,
    serialize({
      type_: JoplinItemType.Folder,
      id: ENCRYPTED_ID,
      title: '',
      parentId: '',
      createdTime: NOW - 100 * HOUR,
      updatedTime: NOW - 100 * HOUR,
      properties: { deleted_time: '0', encryption_applied: '1', encryption_cipher_text: 'JED01000022abcdef' },
    })
  );
  return items;
}

let app: TestApp;
let mock: MockJoplinServer;
const api = (path: string, init: RequestInit = {}) => app.api(path, init);
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

/** Flattens the notebook tree into a list */
function flatten(tree: any[]): any[] {
  return tree.flatMap((nb) => [nb, ...flatten(nb.children)]);
}

async function notebookTree() {
  const res = await api('/api/notebooks');
  assert.equal(res.status, 200);
  return flatten(res.data);
}

async function createNotebook(title: string, parentId?: string): Promise<string> {
  const res = await api('/api/notebooks', json('POST', { title, parentId }));
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data.id;
}

async function createNote(title: string, parentId: string): Promise<string> {
  const res = await api('/api/notes', json('POST', { title, body: 'body', parentId }));
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data.id;
}

before(async () => {
  app = await startTestApp({ items: seedItems(), pageSize: 5, cacheTtlMs: HOUR });
  mock = app.mock;
  await app.login();
});

after(() => app.close());

describe('POST /api/notebooks', () => {
  test('creates a top-level notebook and updates the cache', async () => {
    const res = await api('/api/notebooks', json('POST', { title: 'Archive' }));
    assert.equal(res.status, 201);
    assert.match(res.data.id, /^[0-9a-f]{32}$/);
    assert.deepEqual(res.data, { id: res.data.id, title: 'Archive', parentId: '' });

    const stored = mockItem(mock, res.data.id);
    assert.ok(stored, 'written to Joplin Server');
    assert.equal(stored.type_, JoplinItemType.Folder);
    assert.equal(stored.title, 'Archive');
    assert.equal(stored.parentId, '');
    assert.equal(stored.deletedTime, 0);

    const tree = (await api('/api/notebooks')).data;
    assert.ok(tree.some((nb: any) => nb.id === res.data.id && nb.title === 'Archive'), 'top level of the tree');
  });

  test('creates a nested notebook', async () => {
    const res = await api('/api/notebooks', json('POST', { title: 'Clients', parentId: demoId('nb-work') }));
    assert.equal(res.status, 201);
    assert.equal(res.data.parentId, demoId('nb-work'));
    assert.equal(mockItem(mock, res.data.id)?.parentId, demoId('nb-work'));

    const work = (await api('/api/notebooks')).data.find((nb: any) => nb.id === demoId('nb-work'));
    assert.deepEqual(work.children.map((c: any) => c.title).sort(), ['Clients', 'Meeting Notes', 'Projects']);
  });

  test('flattens and trims the title', async () => {
    const res = await api('/api/notebooks', json('POST', { title: '  Multi\r\nline  ' }));
    assert.equal(res.status, 201);
    assert.equal(res.data.title, 'Multi line');
    assert.equal(mockItem(mock, res.data.id)?.title, 'Multi line');
  });

  test('keeps unicode titles', async () => {
    const res = await api('/api/notebooks', json('POST', { title: 'Küche 🍜 料理' }));
    assert.equal(res.status, 201);
    assert.equal(mockItem(mock, res.data.id)?.title, 'Küche 🍜 料理');
  });

  test('rejects a missing, empty or whitespace title without writing', async () => {
    const before = mockItemsOfType(mock, JoplinItemType.Folder).length;
    for (const body of [{}, { title: '' }, { title: '   ' }, { title: 42 }]) {
      const res = await api('/api/notebooks', json('POST', body));
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    // Only newlines: passes the route check, rejected by the writer after sanitizing
    assert.equal((await api('/api/notebooks', json('POST', { title: '\n\n' }))).status, 400);
    assert.equal(mockItemsOfType(mock, JoplinItemType.Folder).length, before);
  });

  test('rejects an unknown, trashed or non-notebook parent with 404', async () => {
    const before = mockItemsOfType(mock, JoplinItemType.Folder).length;
    for (const parentId of [UNKNOWN_ID, TRASHED_ID, demoId('note-roadmap')]) {
      const res = await api('/api/notebooks', json('POST', { title: 'Orphan', parentId }));
      assert.equal(res.status, 404, parentId);
    }
    assert.equal(mockItemsOfType(mock, JoplinItemType.Folder).length, before);
  });

  test('rejects an invalid parent id with 400', async () => {
    for (const parentId of ['nope', '../evil', 'A'.repeat(32)]) {
      const res = await api('/api/notebooks', json('POST', { title: 'Orphan', parentId }));
      assert.equal(res.status, 400, parentId);
    }
  });
});

describe('PUT /api/notebooks/:id', () => {
  test('renames a notebook and keeps all other properties', async () => {
    const original = mockItem(mock, LEGACY_ID)!;
    const res = await api(`/api/notebooks/${LEGACY_ID}`, json('PUT', { title: 'Legacy (renamed)' }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { id: LEGACY_ID, title: 'Legacy (renamed)', parentId: '' });

    const stored = mockItem(mock, LEGACY_ID)!;
    assert.equal(stored.title, 'Legacy (renamed)');
    assert.equal(stored.properties.x_future_property, 'keep: me\nplease');
    assert.equal(stored.properties.icon, LEGACY_ICON);
    assert.equal(stored.properties.share_id, 'abc');
    assert.equal(stored.properties.created_time, original.properties.created_time);
    assert.equal(stored.parentId, '');
    assert.ok(stored.updatedTime > original.updatedTime, 'updated_time is bumped');
    // Every original property survives
    for (const key of Object.keys(original.properties)) assert.ok(key in stored.properties, `kept ${key}`);

    assert.ok((await notebookTree()).some((nb) => nb.id === LEGACY_ID && nb.title === 'Legacy (renamed)'));
  });

  test('rejects an empty title and leaves the notebook unchanged', async () => {
    const before = mock.items.get(`${LEGACY_ID}.md`)!.content.toString();
    for (const title of ['', '   ', '\n']) {
      assert.equal((await api(`/api/notebooks/${LEGACY_ID}`, json('PUT', { title }))).status, 400, JSON.stringify(title));
    }
    assert.equal(mock.items.get(`${LEGACY_ID}.md`)!.content.toString(), before);
  });

  test('moves a notebook under another one and back to the top level', async () => {
    const reading = demoId('nb-reading');
    const personal = demoId('nb-personal');

    let res = await api(`/api/notebooks/${reading}`, json('PUT', { parentId: personal }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { id: reading, title: 'Reading List', parentId: personal });
    assert.equal(mockItem(mock, reading)?.parentId, personal);
    let tree = (await api('/api/notebooks')).data;
    const personalNode = tree.find((nb: any) => nb.id === personal);
    assert.ok(personalNode.children.some((c: any) => c.id === reading));
    assert.ok(!tree.some((nb: any) => nb.id === reading), 'no longer at the top level');

    res = await api(`/api/notebooks/${reading}`, json('PUT', { parentId: '' }));
    assert.equal(res.status, 200);
    assert.equal(res.data.parentId, '');
    assert.equal(mockItem(mock, reading)?.parentId, '');
    tree = (await api('/api/notebooks')).data;
    assert.ok(tree.some((nb: any) => nb.id === reading));
  });

  test('refuses to move a notebook into itself or a descendant', async () => {
    const work = demoId('nb-work');
    const before = mock.items.get(`${work}.md`)!.content.toString();
    const child = await createNotebook('Deep', demoId('nb-projects'));

    for (const parentId of [work, demoId('nb-projects'), child]) {
      const res = await api(`/api/notebooks/${work}`, json('PUT', { parentId }));
      assert.equal(res.status, 400, parentId);
    }
    assert.equal(mock.items.get(`${work}.md`)!.content.toString(), before, 'nothing written');
  });

  test('refuses to move a notebook under a trashed or unknown notebook', async () => {
    for (const parentId of [TRASHED_ID, UNKNOWN_ID]) {
      const res = await api(`/api/notebooks/${demoId('nb-reading')}`, json('PUT', { parentId }));
      assert.equal(res.status, 404, parentId);
    }
    assert.equal(mockItem(mock, demoId('nb-reading'))?.parentId, '');
  });

  test('validates the notebook id', async () => {
    assert.equal((await api('/api/notebooks/..%2Fevil', json('PUT', { title: 'x' }))).status, 400);
    assert.equal((await api('/api/notebooks/not-an-id', json('PUT', { title: 'x' }))).status, 400);
    assert.equal((await api(`/api/notebooks/${UNKNOWN_ID}`, json('PUT', { title: 'x' }))).status, 404);
    const note = demoId('note-roadmap');
    const before = mock.items.get(`${note}.md`)!.content.toString();
    assert.equal((await api(`/api/notebooks/${note}`, json('PUT', { title: 'x' }))).status, 404);
    assert.equal(mock.items.get(`${note}.md`)!.content.toString(), before, 'note untouched');
  });

  test('refuses to modify an encrypted notebook', async () => {
    const before = mock.items.get(`${ENCRYPTED_ID}.md`)!.content.toString();
    const res = await api(`/api/notebooks/${ENCRYPTED_ID}`, json('PUT', { title: 'Decrypted?' }));
    assert.equal(res.status, 422);
    assert.equal(mock.items.get(`${ENCRYPTED_ID}.md`)!.content.toString(), before);
  });
});

describe('DELETE /api/notebooks/:id', () => {
  let root: string;
  let child: string;
  let grandchild: string;
  let rootNote: string;
  let deepNote: string;
  let alreadyTrashedNote: string;
  let alreadyTrashedTime: number;

  before(async () => {
    root = await createNotebook('Trash me');
    child = await createNotebook('Child', root);
    grandchild = await createNotebook('Grandchild', child);
    rootNote = await createNote('Root note', root);
    deepNote = await createNote('Deep note', grandchild);
    alreadyTrashedNote = await createNote('Trashed earlier', child);
    assert.equal((await api(`/api/notes/${alreadyTrashedNote}`, { method: 'DELETE' })).status, 204);
    alreadyTrashedTime = mockItem(mock, alreadyTrashedNote)!.deletedTime;
    assert.ok(alreadyTrashedTime > 0);
    assert.equal((await api(`/api/notes/${deepNote}/tags`, json('POST', { title: 'purge-me' }))).status, 200);
  });

  test('trashes a notebook with its sub-notebooks and notes', async () => {
    const res = await api(`/api/notebooks/${root}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { notebooks: 3, notes: 2 }, 'the already trashed note is not counted');

    for (const id of [root, child, grandchild, rootNote, deepNote]) {
      const stored = mockItem(mock, id)!;
      assert.ok(stored.deletedTime > 0, `${stored.title} is trashed`);
    }
    assert.equal(mockItem(mock, alreadyTrashedNote)!.deletedTime, alreadyTrashedTime, 'earlier trash time is kept');

    const ids = (await notebookTree()).map((nb) => nb.id);
    for (const id of [root, child, grandchild]) assert.ok(!ids.includes(id), 'hidden from the tree');

    assert.deepEqual((await api(`/api/notes?notebook_id=${root}`)).data, []);
    assert.deepEqual((await api(`/api/notes?notebook_id=${grandchild}`)).data, []);
    const trash = (await api('/api/notes?is_trash=true')).data.map((n: any) => n.id);
    for (const id of [rootNote, deepNote, alreadyTrashedNote]) assert.ok(trash.includes(id), 'listed in the trash');
  });

  test('trashing an already trashed notebook writes nothing', async () => {
    const before = [root, child, grandchild, rootNote, deepNote].map((id) => mock.items.get(`${id}.md`)!.updatedTime);
    const res = await api(`/api/notebooks/${root}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(res.data.notes, 0);
    const afterTimes = [root, child, grandchild, rootNote, deepNote].map((id) => mock.items.get(`${id}.md`)!.updatedTime);
    assert.deepEqual(afterTimes, before);
  });

  test('restoring a note restores its trashed parent notebooks', async () => {
    const res = await api(`/api/notes/${deepNote}/restore`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(res.data.deletedTime, 0);
    for (const id of [deepNote, grandchild, child, root]) {
      assert.equal(mockItem(mock, id)!.deletedTime, 0, `${mockItem(mock, id)!.title} restored`);
    }
    assert.ok(mockItem(mock, rootNote)!.deletedTime > 0, 'sibling notes stay in the trash');
    assert.ok(mockItem(mock, alreadyTrashedNote)!.deletedTime > 0);

    const tree = (await api('/api/notebooks')).data;
    const restoredRoot = tree.find((nb: any) => nb.id === root);
    assert.ok(restoredRoot, 'back in the tree');
    assert.equal(restoredRoot.children[0].id, child);
    assert.equal(restoredRoot.children[0].children[0].id, grandchild);
  });

  test('refuses to purge a notebook that is not in the trash', async () => {
    const sizeBefore = mock.items.size;
    const res = await api(`/api/notebooks/${root}?permanent=true`, { method: 'DELETE' });
    assert.equal(res.status, 409);
    assert.equal(mock.items.size, sizeBefore, 'nothing deleted');
    assert.ok(mockItem(mock, root));
  });

  test('purges a trashed notebook with sub-notebooks, notes and their tag links', async () => {
    const tagLinks = () =>
      mockItemsOfType(mock, JoplinItemType.NoteTag).filter((link) => link.properties.note_id === deepNote);
    assert.equal(tagLinks().length, 1);

    assert.equal((await api(`/api/notebooks/${root}`, { method: 'DELETE' })).status, 200);
    const res = await api(`/api/notebooks/${root}?permanent=1`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { notebooks: 3, notes: 3 }, 'already trashed notes are purged as well');

    for (const id of [root, child, grandchild, rootNote, deepNote, alreadyTrashedNote]) {
      assert.ok(!mock.items.has(`${id}.md`), `${id} deleted from Joplin Server`);
    }
    assert.equal(tagLinks().length, 0, 'note-tag links deleted');
    const trash = (await api('/api/notes?is_trash=true')).data.map((n: any) => n.id);
    assert.ok(!trash.includes(rootNote));
    assert.equal((await api(`/api/notes/${deepNote}`)).status, 404);
  });

  test('purges a notebook that another client trashed', async () => {
    const res = await api(`/api/notebooks/${TRASHED_ID}?permanent=true`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { notebooks: 1, notes: 0 });
    assert.ok(!mock.items.has(`${TRASHED_ID}.md`));
  });

  test('validates the notebook id', async () => {
    const sizeBefore = mock.items.size;
    for (const query of ['', '?permanent=true']) {
      assert.equal((await api(`/api/notebooks/..%2Fevil${query}`, { method: 'DELETE' })).status, 400);
      assert.equal((await api(`/api/notebooks/${UNKNOWN_ID}${query}`, { method: 'DELETE' })).status, 404);
      assert.equal((await api(`/api/notebooks/${demoId('note-roadmap')}${query}`, { method: 'DELETE' })).status, 404);
    }
    assert.equal(mock.items.size, sizeBefore);
    assert.equal(mockItem(mock, demoId('note-roadmap'))!.deletedTime, 0, 'note untouched');
  });

  test('refuses to trash an encrypted notebook', async () => {
    const before = mock.items.get(`${ENCRYPTED_ID}.md`)!.content.toString();
    assert.equal((await api(`/api/notebooks/${ENCRYPTED_ID}`, { method: 'DELETE' })).status, 422);
    assert.equal(mock.items.get(`${ENCRYPTED_ID}.md`)!.content.toString(), before);
  });
});

describe('POST /api/notebooks/refresh', () => {
  test('picks up notebooks created and deleted by another Joplin client', async () => {
    const external = demoId('nb-external');
    putMockItem(mock, {
      type_: JoplinItemType.Folder,
      id: external,
      title: 'From desktop',
      parentId: '',
      createdTime: NOW,
      updatedTime: NOW,
      properties: { deleted_time: '0', encryption_applied: '0' },
    });
    mock.items.delete(`${demoId('nb-recipes')}.md`);

    // Served from the cache until it expires
    let ids = (await notebookTree()).map((nb) => nb.id);
    assert.ok(!ids.includes(external));
    assert.ok(ids.includes(demoId('nb-recipes')));

    const res = await api('/api/notebooks/refresh', { method: 'POST' });
    assert.equal(res.status, 200);
    ids = flatten(res.data).map((nb) => nb.id);
    assert.ok(ids.includes(external), 'new notebook appears');
    assert.ok(!ids.includes(demoId('nb-recipes')), 'deleted notebook disappears');
    assert.ok((await notebookTree()).some((nb) => nb.id === external), 'cache was updated');
  });

  test('requires a session', async () => {
    assert.equal((await app.api('/api/notebooks/refresh', { method: 'POST' }, false)).status, 401);
  });
});
