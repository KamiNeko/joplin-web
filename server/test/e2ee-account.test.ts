import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { syncTargetInfoItem, type MockJoplinServer } from '../demo/mock-joplin-server.js';
import { buildEncryptedDemoItems, demoId } from '../demo/seed.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * An account with end-to-end encryption on (the mock's encrypted variant): the write state the
 * client reads up front, how encrypted items appear in the lists, and that writes stay refused.
 */

let app: TestApp;
let mock: MockJoplinServer;

const api = (path: string, init: RequestInit = {}) => app.api(path, init);
const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});
const refresh = async () => assert.equal((await api('/api/notebooks/refresh', { method: 'POST' })).status, 200);

const VAULT = demoId('nb-vault');
const SECRET = demoId('note-secret');
const DIARY = demoId('note-diary');
const PRIVATE_TAG = demoId('tag-private');
const PERSONAL = demoId('nb-personal');

/** Snapshot of every item's content, to prove a refused request wrote nothing */
function snapshot(): Map<string, string> {
  return new Map([...mock.items].map(([name, item]) => [name, item.content.toString('base64')]));
}

before(async () => {
  app = await startTestApp({ items: buildEncryptedDemoItems() });
  mock = app.mock;
  await app.login();
});

after(() => app.close());

describe('write state', () => {
  test('reports the account as read-only with the reason a write would be refused with', async () => {
    const state = await api('/api/account/write-state');
    assert.equal(state.status, 200);
    assert.equal(state.data.writable, false);
    assert.match(state.data.reason, /end-to-end encryption/);

    const write = await api(`/api/notes/${demoId('note-roadmap')}`, json('PUT', { body: 'leak' }));
    assert.equal(write.status, 422);
    assert.equal(write.data.error, state.data.reason, 'the same message as the 422 refusal');
  });

  test('follows info.json and the encrypted items on the account', async () => {
    const seeded = mock.items.get('info.json')!;
    try {
      // E2EE turned off again: the account is writable, only the encrypted items stay refused
      mock.items.set('info.json', syncTargetInfoItem(false, Date.now()));
      await refresh();
      assert.deepEqual((await api('/api/account/write-state')).data, { writable: true });

      // No info.json (old sync target) while encrypted items exist: read-only, fail safe
      mock.items.delete('info.json');
      await refresh();
      const state = await api('/api/account/write-state');
      assert.equal(state.data.writable, false);
      assert.match(state.data.reason, /end-to-end encrypted data/);
    } finally {
      mock.items.set('info.json', seeded);
      await refresh();
    }
    assert.equal((await api('/api/account/write-state')).data.writable, false);
  });

  test('an unreadable info.json makes the account read-only', async () => {
    const seeded = mock.items.get('info.json')!;
    try {
      mock.items.set('info.json', { ...seeded, content: Buffer.from('{not json'), updatedTime: Date.now() });
      await refresh();
      const state = await api('/api/account/write-state');
      assert.equal(state.data.writable, false);
      assert.match(state.data.reason, /info\.json/);
    } finally {
      mock.items.set('info.json', seeded);
      await refresh();
    }
  });
});

describe('encrypted items in the lists', () => {
  test('marks an encrypted notebook in the tree', async () => {
    const res = await api('/api/notebooks');
    const vault = res.data.find((nb: any) => nb.id === VAULT);
    assert.ok(vault, 'encrypted notebook is listed');
    assert.equal(vault.encrypted, true);
    assert.equal(vault.title, 'Encrypted notebook');
    assert.equal(vault.noteCount, 1);
    const personal = res.data.find((nb: any) => nb.id === PERSONAL);
    assert.equal(personal.encrypted, false);
  });

  test('marks encrypted notes in note lists, with no title or preview', async () => {
    const res = await api(`/api/notes?notebook_id=${PERSONAL}`);
    const diary = res.data.find((n: any) => n.id === DIARY);
    assert.ok(diary, 'encrypted note is listed in its readable notebook');
    assert.equal(diary.encrypted, true);
    assert.equal(diary.title, '');
    assert.equal(diary.preview, '');
    assert.ok(res.data.filter((n: any) => n.id !== DIARY).every((n: any) => n.encrypted === false));
  });

  test('marks an encrypted note in its details, including its notebook and tags', async () => {
    const res = await api(`/api/notes/${SECRET}`);
    assert.equal(res.status, 200);
    assert.equal(res.data.encrypted, true);
    assert.equal(res.data.body, '');
    assert.equal(res.data.notebookTitle, 'Encrypted notebook');

    const diary = await api(`/api/notes/${DIARY}`);
    assert.deepEqual(diary.data.tags, [{ id: PRIVATE_TAG, title: 'Encrypted tag' }]);
  });

  test('marks an encrypted tag', async () => {
    const res = await api('/api/tags');
    const tag = res.data.find((t: any) => t.id === PRIVATE_TAG);
    assert.equal(tag.encrypted, true);
    assert.equal(tag.title, 'Encrypted tag');
    assert.equal(tag.noteCount, 1);
  });

  test('search never matches the cipher text', async () => {
    const res = await api('/api/search?q=JED01');
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, []);
  });
});

describe('writes', () => {
  test('every kind of write is still refused with 422 and nothing is uploaded', async () => {
    const before = snapshot();
    const responses = [
      await api('/api/notes', json('POST', { title: 'leak', body: 'x', parentId: PERSONAL })),
      await api(`/api/notes/${SECRET}`, json('PUT', { body: 'x' })),
      await api(`/api/notes/${DIARY}/tags`, json('POST', { title: 'x' })),
      await api('/api/notebooks', json('POST', { title: 'leak' })),
      await api(`/api/tags/${PRIVATE_TAG}`, json('PUT', { title: 'x' })),
      await api('/api/resources', {
        method: 'POST',
        body: new TextEncoder().encode('hello'),
        headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'a.txt', 'X-File-Type': 'text/plain' },
      }),
    ];
    for (const res of responses) assert.equal(res.status, 422, JSON.stringify(res.data));
    assert.deepEqual(snapshot(), before);
  });
});
