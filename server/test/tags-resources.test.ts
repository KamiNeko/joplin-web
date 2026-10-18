import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { MockJoplinServer } from '../demo/mock-joplin-server.js';
import { buildDemoItems, demoId } from '../demo/seed.js';
import { serialize } from '../src/services/serializer.js';
import { JoplinItemType } from '../src/types/index.js';
import { mockItem, mockItemsOfType, startTestApp, type TestApp } from './helpers.js';

/**
 * Tag endpoints (tag/untag a note, rename, delete) and attachment deletion/upload errors
 * against the mock Joplin Server.
 */

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();
const UNKNOWN_ID = 'f'.repeat(32);
/** A tag written by another Joplin client with properties Joplin Web doesn't know about */
const LEGACY_TAG = demoId('tag-legacy');
/** An end-to-end encrypted tag */
const ENCRYPTED_TAG = demoId('tag-encrypted');

function seedItems() {
  const items = buildDemoItems(NOW);
  const put = (id: string, content: string) =>
    items.set(`${id}.md`, { content: Buffer.from(content, 'utf8'), contentType: 'text/plain; charset=utf-8', updatedTime: NOW - 1000 });
  put(
    LEGACY_TAG,
    serialize({
      type_: JoplinItemType.Tag,
      id: LEGACY_TAG,
      title: 'legacy',
      createdTime: NOW - 100_000,
      updatedTime: NOW - 100_000,
      properties: { parent_id: '', is_shared: '0', x_future_property: 'a: b\nc', encryption_applied: '0' },
    })
  );
  put(
    ENCRYPTED_TAG,
    serialize({
      type_: JoplinItemType.Tag,
      id: ENCRYPTED_TAG,
      title: '',
      createdTime: NOW - 100_000,
      updatedTime: NOW - 100_000,
      properties: { encryption_applied: '1', encryption_cipher_text: 'JED01000022abcdef' },
    })
  );
  return items;
}

let app: TestApp;
/** Imported after startTestApp(): importing backend modules earlier would load the config without the mock's URL */
let MAX_UPLOAD_BYTES: number;
let mock: MockJoplinServer;
const api = (path: string, init: RequestInit = {}) => app.api(path, init);
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

const tags = () => mockItemsOfType(mock, JoplinItemType.Tag);
const links = (noteId?: string) =>
  mockItemsOfType(mock, JoplinItemType.NoteTag).filter((l) => !noteId || l.properties.note_id === noteId);

async function tagCount(title: string): Promise<number | undefined> {
  const res = await api('/api/tags');
  assert.equal(res.status, 200);
  return res.data.find((t: any) => t.title === title)?.noteCount;
}

async function upload(name: string, data: Buffer): Promise<string> {
  const res = await api('/api/resources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name), 'X-File-Type': 'text/plain' },
    body: data,
  });
  assert.equal(res.status, 201);
  return res.data.id;
}

before(async () => {
  app = await startTestApp({ items: seedItems(), pageSize: 6, cacheTtlMs: HOUR });
  mock = app.mock;
  ({ MAX_UPLOAD_BYTES } = await import('../src/routes/resources.js'));
  await app.login();
});

after(() => app.close());

describe('POST /api/notes/:id/tags', () => {
  const ramen = demoId('note-ramen');

  test('reuses an existing tag matched case-insensitively', async () => {
    const tagsBefore = tags().length;
    const noteBefore = mock.items.get(`${ramen}.md`)!.content.toString();

    const res = await api(`/api/notes/${ramen}/tags`, json('POST', { title: 'IMPORTANT' }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.tags.map((t: any) => t.title).sort(), ['cooking', 'important']);
    assert.ok(res.data.tags.some((t: any) => t.id === demoId('tag-important')));

    assert.equal(tags().length, tagsBefore, 'no new tag item');
    const newLinks = links(ramen).filter((l) => l.properties.tag_id === demoId('tag-important'));
    assert.equal(newLinks.length, 1, 'exactly one note-tag link');
    assert.match(newLinks[0].id, /^[0-9a-f]{32}$/);
    assert.equal(mock.items.get(`${ramen}.md`)!.content.toString(), noteBefore, 'the note item itself is not modified');
  });

  test('creates a new tag and is idempotent', async () => {
    const tagsBefore = tags().length;
    let res = await api(`/api/notes/${ramen}/tags`, json('POST', { title: '  Weekend\nfood ' }));
    assert.equal(res.status, 200);
    const created = res.data.tags.find((t: any) => t.title === 'Weekend food');
    assert.ok(created, 'title trimmed and flattened');
    assert.equal(tags().length, tagsBefore + 1);
    assert.equal(mockItem(mock, created.id)?.type_, JoplinItemType.Tag);
    assert.equal(mockItem(mock, created.id)?.title, 'Weekend food');
    assert.equal(links(ramen).filter((l) => l.properties.tag_id === created.id).length, 1);

    res = await api(`/api/notes/${ramen}/tags`, json('POST', { title: 'weekend FOOD' }));
    assert.equal(res.status, 200);
    assert.equal(tags().length, tagsBefore + 1, 'no duplicate tag');
    assert.equal(links(ramen).filter((l) => l.properties.tag_id === created.id).length, 1, 'no duplicate link');
    assert.equal(await tagCount('Weekend food'), 1);
  });

  test('keeps unicode tag titles', async () => {
    const res = await api(`/api/notes/${ramen}/tags`, json('POST', { title: 'Küche 🍜' }));
    assert.equal(res.status, 200);
    const tag = res.data.tags.find((t: any) => t.title === 'Küche 🍜');
    assert.ok(tag);
    assert.equal(mockItem(mock, tag.id)?.title, 'Küche 🍜');
  });

  test('rejects a missing or empty title', async () => {
    const sizeBefore = mock.items.size;
    for (const body of [{}, { title: '' }, { title: '  ' }, { title: ['x'] }]) {
      assert.equal((await api(`/api/notes/${ramen}/tags`, json('POST', body))).status, 400, JSON.stringify(body));
    }
    assert.equal((await api(`/api/notes/${ramen}/tags`, json('POST', { title: '\r\n' }))).status, 400);
    assert.equal(mock.items.size, sizeBefore);
  });

  test('rejects invalid and unknown notes', async () => {
    const sizeBefore = mock.items.size;
    assert.equal((await api('/api/notes/..%2Fevil/tags', json('POST', { title: 'x' }))).status, 400);
    assert.equal((await api(`/api/notes/${UNKNOWN_ID}/tags`, json('POST', { title: 'x' }))).status, 404);
    assert.equal((await api(`/api/notes/${demoId('nb-work')}/tags`, json('POST', { title: 'x' }))).status, 404);
    assert.equal(mock.items.size, sizeBefore);
  });

  test('rejects tagging a trashed note', async () => {
    const trashed = demoId('note-old-draft');
    const sizeBefore = mock.items.size;
    const res = await api(`/api/notes/${trashed}/tags`, json('POST', { title: 'x-trashed' }));
    assert.equal(res.status, 404);
    assert.equal(mock.items.size, sizeBefore, 'no tag or link written');
  });
});

describe('DELETE /api/notes/:id/tags/:tagId', () => {
  const sync = demoId('note-weekly-sync');
  const planning = demoId('tag-planning');

  test('removes the note-tag link but keeps the tag', async () => {
    const countBefore = await tagCount('planning');
    assert.ok(mock.items.has(`${demoId('link-weekly-sync-planning')}.md`));

    const res = await api(`/api/notes/${sync}/tags/${planning}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.tags, []);

    assert.ok(!mock.items.has(`${demoId('link-weekly-sync-planning')}.md`), 'link deleted from Joplin Server');
    assert.ok(mock.items.has(`${planning}.md`), 'tag kept');
    assert.deepEqual((await api(`/api/notes/${sync}`)).data.tags, []);
    assert.equal(await tagCount('planning'), countBefore! - 1);
  });

  test('is a no-op for a tag the note does not have', async () => {
    const sizeBefore = mock.items.size;
    const res = await api(`/api/notes/${sync}/tags/${demoId('tag-cooking')}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(mock.items.size, sizeBefore);
  });

  test('validates ids', async () => {
    assert.equal((await api(`/api/notes/${sync}/tags/..%2Fevil`, { method: 'DELETE' })).status, 400);
    assert.equal((await api(`/api/notes/not-an-id/tags/${planning}`, { method: 'DELETE' })).status, 400);
    assert.equal((await api(`/api/notes/${UNKNOWN_ID}/tags/${planning}`, { method: 'DELETE' })).status, 404);
  });
});

describe('PUT /api/tags/:id', () => {
  test('renames a tag and keeps its other properties', async () => {
    const original = mockItem(mock, LEGACY_TAG)!;
    const res = await api(`/api/tags/${LEGACY_TAG}`, json('PUT', { title: ' Heritage ' }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { id: LEGACY_TAG, title: 'Heritage' });

    const stored = mockItem(mock, LEGACY_TAG)!;
    assert.equal(stored.title, 'Heritage');
    assert.equal(stored.type_, JoplinItemType.Tag);
    assert.equal(stored.properties.x_future_property, 'a: b\nc');
    assert.equal(stored.properties.created_time, original.properties.created_time);
    for (const key of Object.keys(original.properties)) assert.ok(key in stored.properties, `kept ${key}`);
    assert.ok(stored.updatedTime > original.updatedTime);

    const listed = (await api('/api/tags')).data.map((t: any) => t.title);
    assert.ok(listed.includes('Heritage') && !listed.includes('legacy'));
  });

  test('allows changing the case of its own title', async () => {
    const res = await api(`/api/tags/${demoId('tag-books')}`, json('PUT', { title: 'Books' }));
    assert.equal(res.status, 200);
    assert.equal(mockItem(mock, demoId('tag-books'))?.title, 'Books');
  });

  test('refuses a title that another tag already has', async () => {
    const before = mock.items.get(`${demoId('tag-ideas')}.md`)!.content.toString();
    const res = await api(`/api/tags/${demoId('tag-ideas')}`, json('PUT', { title: 'COOKING' }));
    assert.equal(res.status, 409);
    assert.match(res.data.error, /already exists/);
    assert.equal(mock.items.get(`${demoId('tag-ideas')}.md`)!.content.toString(), before);
  });

  test('rejects empty titles and invalid or unknown ids', async () => {
    for (const title of ['', '   ', '\n']) {
      assert.equal((await api(`/api/tags/${demoId('tag-ideas')}`, json('PUT', { title }))).status, 400, JSON.stringify(title));
    }
    assert.equal((await api(`/api/tags/${demoId('tag-ideas')}`, json('PUT', {}))).status, 400);
    assert.equal((await api('/api/tags/..%2Fevil', json('PUT', { title: 'x' }))).status, 400);
    assert.equal((await api(`/api/tags/${UNKNOWN_ID}`, json('PUT', { title: 'x' }))).status, 404);
    const note = demoId('note-roadmap');
    const noteBefore = mock.items.get(`${note}.md`)!.content.toString();
    assert.equal((await api(`/api/tags/${note}`, json('PUT', { title: 'x' }))).status, 404);
    assert.equal(mock.items.get(`${note}.md`)!.content.toString(), noteBefore);
  });

  test('refuses to rename an encrypted tag', async () => {
    const before = mock.items.get(`${ENCRYPTED_TAG}.md`)!.content.toString();
    assert.equal((await api(`/api/tags/${ENCRYPTED_TAG}`, json('PUT', { title: 'x' }))).status, 422);
    assert.equal(mock.items.get(`${ENCRYPTED_TAG}.md`)!.content.toString(), before);
  });
});

describe('DELETE /api/tags/:id', () => {
  test('deletes a tag with all its note-tag links', async () => {
    const cooking = demoId('tag-cooking');
    const cookingLinks = links().filter((l) => l.properties.tag_id === cooking);
    assert.equal(cookingLinks.length, 2);

    const res = await api(`/api/tags/${cooking}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { notes: 2 });

    assert.ok(!mock.items.has(`${cooking}.md`), 'tag deleted');
    for (const link of cookingLinks) assert.ok(!mock.items.has(`${link.id}.md`), 'link deleted');
    assert.equal(await tagCount('cooking'), undefined);

    // The notes themselves stay
    for (const key of ['note-ramen', 'note-sourdough']) {
      const note = await api(`/api/notes/${demoId(key)}`);
      assert.equal(note.status, 200);
      assert.ok(!note.data.tags.some((t: any) => t.id === cooking));
    }
  });

  test('rejects invalid, unknown and non-tag ids', async () => {
    const sizeBefore = mock.items.size;
    assert.equal((await api('/api/tags/..%2Fevil', { method: 'DELETE' })).status, 400);
    assert.equal((await api(`/api/tags/${UNKNOWN_ID}`, { method: 'DELETE' })).status, 404);
    assert.equal((await api(`/api/tags/${demoId('note-roadmap')}`, { method: 'DELETE' })).status, 404);
    assert.equal((await api(`/api/tags/${ENCRYPTED_TAG}`, { method: 'DELETE' })).status, 422);
    assert.equal(mock.items.size, sizeBefore);
  });
});

describe('DELETE /api/resources/:id', () => {
  test('deletes an attachment with its metadata and file', async () => {
    const id = await upload('notes.txt', Buffer.from('hello'));
    assert.ok(mock.items.has(`${id}.md`) && mock.items.has(`.resource/${id}`));
    assert.equal((await api(`/api/resources/${id}`)).status, 200);

    const res = await api(`/api/resources/${id}`, { method: 'DELETE' });
    assert.equal(res.status, 204);
    assert.ok(!mock.items.has(`${id}.md`), 'metadata deleted');
    assert.ok(!mock.items.has(`.resource/${id}`), 'file deleted');
    assert.equal((await api(`/api/resources/${id}`)).status, 404);
  });

  test('deletes seeded attachments without touching the notes linking to them', async () => {
    const tram = demoId('res-tram');
    const lisbon = demoId('note-lisbon');
    const noteBefore = mock.items.get(`${lisbon}.md`)!.content.toString();
    assert.equal((await api(`/api/resources/${tram}`, { method: 'DELETE' })).status, 204);
    assert.ok(!mock.items.has(`${tram}.md`) && !mock.items.has(`.resource/${tram}`));
    assert.equal(mock.items.get(`${lisbon}.md`)!.content.toString(), noteBefore);
  });

  test('rejects invalid, unknown and non-resource ids', async () => {
    const sizeBefore = mock.items.size;
    assert.equal((await api('/api/resources/..%2Fevil', { method: 'DELETE' })).status, 400);
    assert.equal((await api('/api/resources/not-an-id', { method: 'DELETE' })).status, 400);
    assert.equal((await api(`/api/resources/${UNKNOWN_ID}`, { method: 'DELETE' })).status, 404);
    assert.equal((await api(`/api/resources/${demoId('note-roadmap')}`, { method: 'DELETE' })).status, 404);
    assert.equal(mock.items.size, sizeBefore);
  });
});

describe('POST /api/resources errors', () => {
  test('rejects an empty upload', async () => {
    const sizeBefore = mock.items.size;
    const res = await api('/api/resources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'empty.txt' },
      body: Buffer.alloc(0),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.data, { error: 'No file content received' });
    assert.equal(mock.items.size, sizeBefore);
  });

  test('rejects uploads above the size limit with 413', async () => {
    const sizeBefore = mock.items.size;
    const res = await api('/api/resources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'big.bin' },
      body: Buffer.alloc(MAX_UPLOAD_BYTES + 1),
    });
    assert.equal(res.status, 413);
    assert.deepEqual(res.data, { error: 'The file is too large to upload' });
    assert.equal(mock.items.size, sizeBefore);
  });

  test('accepts an upload of exactly the size limit', async () => {
    const id = await upload('limit.bin', Buffer.alloc(MAX_UPLOAD_BYTES, 1));
    assert.equal(mock.items.get(`.resource/${id}`)?.content.length, MAX_UPLOAD_BYTES);
    assert.equal(mockItem(mock, id)?.properties.size, String(MAX_UPLOAD_BYTES));
  });
});
