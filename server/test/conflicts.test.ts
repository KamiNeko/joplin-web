import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { MockJoplinServer } from '../demo/mock-joplin-server.js';
import { buildDemoItems, demoId } from '../demo/seed.js';
import { JoplinItemType } from '../src/types/index.js';
import { mockItem, putMockItem, startTestApp, type TestApp } from './helpers.js';

/**
 * Conflict copies (`is_conflict: 1`) the way Joplin desktop/mobile create them on a sync conflict:
 * hidden from notebooks, "All notes", tag counts and search, listed only with `is_conflict=true`
 * (Joplin's "Conflicts" folder), and left alone by notebook trash/purge cascades.
 */

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();
const ORIGINAL = demoId('note-roadmap');
const CONFLICT = demoId('note-roadmap-conflict');
const PROJECTS = demoId('nb-projects');
/** A notebook with one regular note and one conflict copy, trashed and purged in the tests */
const SCRATCH = demoId('nb-conflict-scratch');
const SCRATCH_NOTE = demoId('note-conflict-scratch');
const SCRATCH_CONFLICT = demoId('note-conflict-scratch-copy');
const LINK = demoId('link-conflict-planning');

let app: TestApp;
let mock: MockJoplinServer;
const api = (path: string, init: RequestInit = {}) => app.api(path, init);
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });
const ids = (list: Array<{ id: string }>) => list.map((n) => n.id);
const conflicts = async () => ids((await api('/api/notes?is_conflict=true')).data);
const trash = async () => ids((await api('/api/notes?is_trash=true')).data);

before(async () => {
  const items = buildDemoItems(NOW);
  app = await startTestApp({ items });
  mock = app.mock;
  putMockItem(mock, {
    type_: JoplinItemType.Folder,
    id: SCRATCH,
    title: 'Scratch',
    parentId: '',
    createdTime: NOW - HOUR,
    updatedTime: NOW - HOUR,
    properties: { deleted_time: '0', encryption_applied: '0' },
  });
  for (const [id, conflict] of [[SCRATCH_NOTE, false], [SCRATCH_CONFLICT, true]] as const) {
    putMockItem(mock, {
      type_: JoplinItemType.Note,
      id,
      title: 'Scratch note',
      body: conflict ? 'their version' : 'my version',
      parentId: SCRATCH,
      createdTime: NOW - HOUR,
      updatedTime: NOW - HOUR,
      properties: {
        deleted_time: '0',
        encryption_applied: '0',
        is_conflict: conflict ? '1' : '0',
        conflict_original_id: conflict ? SCRATCH_NOTE : '',
      },
    });
  }
  // A conflict copy linked to a tag (Joplin copies no links, but another client could add one)
  putMockItem(mock, {
    type_: JoplinItemType.NoteTag,
    id: LINK,
    createdTime: NOW,
    updatedTime: NOW,
    properties: { note_id: CONFLICT, tag_id: demoId('tag-planning') },
  });
  await app.login();
});

after(() => app.close());

describe('conflict copies in lists', () => {
  test('are hidden from notebook lists, "All notes" and notebook note counts', async () => {
    const projects = ids((await api(`/api/notes?notebook_id=${PROJECTS}`)).data);
    assert.ok(projects.includes(ORIGINAL));
    assert.ok(!projects.includes(CONFLICT));
    assert.ok(!ids((await api('/api/notes')).data).includes(CONFLICT));

    const tree = (await api('/api/notebooks')).data;
    const work = tree.find((nb: any) => nb.title === 'Work');
    const projectsNode = work.children.find((nb: any) => nb.id === PROJECTS);
    assert.equal(projectsNode.noteCount, projects.length, 'count matches the list, without the copy');
  });

  test('are not counted for tags and not listed by tag', async () => {
    const planning = (await api('/api/tags')).data.find((t: any) => t.title === 'planning');
    const tagged = ids((await api(`/api/notes?tag_id=${demoId('tag-planning')}`)).data);
    assert.ok(!tagged.includes(CONFLICT));
    assert.equal(planning.noteCount, tagged.length);
  });

  test('are not found by search', async () => {
    assert.deepEqual((await api('/api/search?q=cookie%20banner')).data, []);
    const found = ids((await api('/api/search?q=Website%20Relaunch%20Roadmap')).data);
    assert.ok(found.includes(ORIGINAL));
    assert.ok(!found.includes(CONFLICT), 'same title, but only the original is found');
  });

  test('are listed with is_conflict=true and marked in the note details', async () => {
    const list = (await api('/api/notes?is_conflict=true')).data;
    assert.deepEqual(ids(list).sort(), [CONFLICT, SCRATCH_CONFLICT].sort());
    assert.ok(list.every((n: any) => n.isConflict === true));
    // Other filters don't apply to the conflicts list
    assert.deepEqual(ids((await api(`/api/notes?is_conflict=true&notebook_id=${PROJECTS}`)).data).sort(), ids(list).sort());

    const detail = (await api(`/api/notes/${CONFLICT}`)).data;
    assert.equal(detail.isConflict, true);
    assert.equal(detail.conflictOriginalId, ORIGINAL);
    assert.equal(detail.deletedTime, 0);
    const original = (await api(`/api/notes/${ORIGINAL}`)).data;
    assert.equal(original.isConflict, false);
    assert.equal(original.conflictOriginalId, '');
  });

  test('editing a conflict copy keeps it a conflict copy', async () => {
    const before = (await api(`/api/notes/${CONFLICT}`)).data;
    const res = await api(`/api/notes/${CONFLICT}`, json('PUT', { body: 'Edited copy', baseUpdatedTime: before.updatedTime }));
    assert.equal(res.status, 200);
    const stored = mockItem(mock, CONFLICT)!;
    assert.equal(stored.body, 'Edited copy');
    assert.equal(stored.properties.is_conflict, '1');
    assert.equal(stored.properties.conflict_original_id, ORIGINAL);
    assert.ok((await conflicts()).includes(CONFLICT));
  });
});

describe('trashing and deleting conflict copies', () => {
  test('trash, restore and permanently delete a conflict copy', async () => {
    assert.equal((await api(`/api/notes/${CONFLICT}`, { method: 'DELETE' })).status, 204);
    let stored = mockItem(mock, CONFLICT)!;
    assert.ok(stored.deletedTime > 0);
    assert.equal(stored.properties.is_conflict, '1', 'stays a conflict copy in the trash, as in Joplin');
    assert.ok(!(await conflicts()).includes(CONFLICT));
    assert.ok((await trash()).includes(CONFLICT));
    assert.ok((await api(`/api/notes/${CONFLICT}`)).data.deletedTime > 0);

    assert.equal((await api(`/api/notes/${CONFLICT}/restore`, { method: 'POST' })).status, 200);
    stored = mockItem(mock, CONFLICT)!;
    assert.equal(stored.deletedTime, 0);
    assert.equal(stored.properties.is_conflict, '1');
    assert.ok((await conflicts()).includes(CONFLICT), 'back in the conflicts list');
    assert.ok(!(await trash()).includes(CONFLICT));

    // Only trashed copies can be purged
    assert.equal((await api(`/api/notes/${CONFLICT}?permanent=true`, { method: 'DELETE' })).status, 409);
    assert.equal((await api(`/api/notes/${CONFLICT}`, { method: 'DELETE' })).status, 204);
    assert.equal((await api(`/api/notes/${CONFLICT}?permanent=true`, { method: 'DELETE' })).status, 204);
    assert.equal(mockItem(mock, CONFLICT), undefined);
    assert.equal(mockItem(mock, LINK), undefined, 'note-tag link removed with it');
    assert.ok(!(await conflicts()).includes(CONFLICT));
    assert.equal(mockItem(mock, ORIGINAL)!.deletedTime, 0, 'original untouched');
  });

  test('trashing a notebook leaves its conflict copies in "Conflicts", like Joplin desktop', async () => {
    const res = await api(`/api/notebooks/${SCRATCH}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.ok(mockItem(mock, SCRATCH_NOTE)!.deletedTime > 0);
    assert.equal(mockItem(mock, SCRATCH_CONFLICT)!.deletedTime, 0, 'conflict copy not trashed');

    const trashed = await trash();
    assert.ok(trashed.includes(SCRATCH_NOTE));
    assert.ok(!trashed.includes(SCRATCH_CONFLICT));
    assert.ok((await conflicts()).includes(SCRATCH_CONFLICT));
    assert.equal((await api(`/api/notes/${SCRATCH_CONFLICT}`)).data.deletedTime, 0);
    const listed = (await api('/api/notebooks/trash')).data.find((nb: any) => nb.id === SCRATCH);
    assert.deepEqual([listed.noteCount, listed.earlierNoteCount], [1, 0], 'the copy is not counted');

    // It is not in the trash, so it cannot be purged without trashing it first
    assert.equal((await api(`/api/notes/${SCRATCH_CONFLICT}?permanent=true`, { method: 'DELETE' })).status, 409);
    // Restoring it does not restore its trashed notebook
    assert.equal((await api(`/api/notes/${SCRATCH_CONFLICT}/restore`, { method: 'POST' })).status, 200);
    assert.ok(mockItem(mock, SCRATCH)!.deletedTime > 0);
  });

  test('purging a notebook keeps conflict copies that are not trashed', async () => {
    const res = await api(`/api/notebooks/${SCRATCH}?permanent=true`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(res.data.notes, 1);
    assert.equal(mockItem(mock, SCRATCH), undefined);
    assert.equal(mockItem(mock, SCRATCH_NOTE), undefined);
    assert.ok(mockItem(mock, SCRATCH_CONFLICT), 'conflict copy kept');
    assert.ok((await conflicts()).includes(SCRATCH_CONFLICT));
    const detail = (await api(`/api/notes/${SCRATCH_CONFLICT}`)).data;
    assert.equal(detail.notebook, null);
    assert.equal(detail.deletedTime, 0);
  });

  test('moving a conflict copy to a notebook turns it into a regular note (Note.moveToFolder)', async () => {
    const before = mockItem(mock, SCRATCH_CONFLICT)!;
    const res = await api(`/api/notes/${SCRATCH_CONFLICT}`, json('PUT', { parentId: demoId('nb-reading') }));
    assert.equal(res.status, 200);
    assert.equal(res.data.isConflict, false);
    const stored = mockItem(mock, SCRATCH_CONFLICT)!;
    assert.equal(stored.properties.is_conflict, '0');
    assert.equal(stored.properties.conflict_original_id, '');
    assert.equal(stored.parentId, demoId('nb-reading'));
    assert.equal(stored.body, before.body);
    assert.equal(stored.properties.created_time, before.properties.created_time, 'other properties kept');
    assert.ok(!(await conflicts()).includes(SCRATCH_CONFLICT));
    assert.ok(ids((await api(`/api/notes?notebook_id=${demoId('nb-reading')}`)).data).includes(SCRATCH_CONFLICT));
    assert.deepEqual(await conflicts(), []);
  });
});
