import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { syncTargetInfoItem, type MockJoplinServer } from '../demo/mock-joplin-server.js';
import { DEMO_EMAIL, DEMO_PASSWORD, demoId } from '../demo/seed.js';
import { deserialize, serialize } from '../src/services/serializer.js';
import { JoplinItemType } from '../src/types/index.js';
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
    assert.equal(matches.matchedIn, undefined);
    assert.match(matches.snippet, /biometric/);
  });

  test('search finds notes by attachment OCR text and marks OCR-only matches', async () => {
    const res = await api('/api/search?q=%22Backup%20Storage%22%20420.00');
    assert.equal(res.status, 200);
    assert.equal(res.data.length, 1);
    assert.equal(res.data[0].id, demoId('note-scanned-invoice'));
    assert.equal(res.data[0].title, '2024_03_11.pdf');
    assert.deepEqual(res.data[0].matches.inTitle, false);
    assert.deepEqual(res.data[0].matches.inBody, false);
    assert.equal(res.data[0].matches.matchedIn, 'attachment');
    assert.deepEqual(res.data[0].matches.terms, ['backup storage', '420.00']);
    assert.match(res.data[0].matches.snippet, /Backup Storage/);

    // Combining a title term and an attachment term clears matchedIn (not OCR-only)
    const mixed = await api('/api/search?q=2024_03_11%20Storage');
    assert.equal(mixed.status, 200);
    assert.equal(mixed.data.length, 1);
    assert.equal(mixed.data[0].matches.inTitle, true);
    assert.equal(mixed.data[0].matches.matchedIn, undefined);
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

describe('batch updates', () => {
  async function createTestNote(title: string, parentId = demoId('nb-projects')) {
    const res = await api('/api/notes', {
      method: 'POST',
      body: JSON.stringify({ title, body: `Body for ${title}`, parentId }),
    });
    assert.equal(res.status, 201);
    return res.data as { id: string; updatedTime: number; parentId: string; title: string };
  }

  test('moves notes in bulk and supports per-item parentId and title updates', async () => {
    const n1 = await createTestNote('Bulk Move 1', demoId('nb-projects'));
    const n2 = await createTestNote('Bulk Move 2', demoId('nb-meetings'));

    const moveRes = await api('/api/notes/batch', {
      method: 'POST',
      body: JSON.stringify({
        items: [
          { id: n1.id, baseUpdatedTime: n1.updatedTime },
          { id: n2.id, baseUpdatedTime: n2.updatedTime },
        ],
        parentId: demoId('nb-reading'),
      }),
    });
    assert.equal(moveRes.status, 200);
    assert.equal(moveRes.data.length, 2);
    assert.equal(moveRes.data[0].status, 'ok');
    assert.equal(moveRes.data[1].status, 'ok');
    assert.ok(moveRes.data[0].updatedTime > n1.updatedTime);

    const readingList = await api(`/api/notes?notebook_id=${demoId('nb-reading')}`);
    assert.ok(readingList.data.some((n: any) => n.id === n1.id));
    assert.ok(readingList.data.some((n: any) => n.id === n2.id));

    // Per-item undo / AI auto-organize shape: move back to original mixed notebooks + rename title
    const undoRes = await api('/api/notes/batch', {
      method: 'POST',
      body: JSON.stringify({
        items: [
          { id: n1.id, baseUpdatedTime: moveRes.data[0].updatedTime, parentId: n1.parentId, title: 'Renamed 1' },
          { id: n2.id, baseUpdatedTime: moveRes.data[1].updatedTime, parentId: n2.parentId },
        ],
      }),
    });
    assert.equal(undoRes.status, 200);
    assert.deepEqual(
      undoRes.data.map((r: any) => r.status),
      ['ok', 'ok']
    );
    assert.equal((await api(`/api/notes/${n1.id}`)).data.parentId, demoId('nb-projects'));
    assert.equal((await api(`/api/notes/${n1.id}`)).data.title, 'Renamed 1');
    assert.equal((await api(`/api/notes/${n2.id}`)).data.parentId, demoId('nb-meetings'));
  });

  test('detects baseUpdatedTime conflicts per item and refreshes cache', async () => {
    const n1 = await createTestNote('Batch Conflict', demoId('nb-projects'));
    const raw = mock.items.get(`${n1.id}.md`)!.content.toString('utf8');
    const serverCopy = deserialize(raw, `${n1.id}.md`);
    const newerTime = n1.updatedTime + 5000;
    mock.items.set(`${n1.id}.md`, {
      content: Buffer.from(
        serialize({
          type_: JoplinItemType.Note,
          title: serverCopy.title,
          body: 'Edited elsewhere',
          properties: { ...serverCopy.properties, updated_time: new Date(newerTime).toISOString() },
        }),
        'utf8'
      ),
      contentType: 'text/plain; charset=utf-8',
      updatedTime: newerTime,
    });

    const res = await api('/api/notes/batch', {
      method: 'POST',
      body: JSON.stringify({
        items: [{ id: n1.id, baseUpdatedTime: n1.updatedTime }],
        parentId: demoId('nb-travel'),
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.data[0].id, n1.id);
    assert.equal(res.data[0].status, 'conflict');
    assert.match(res.data[0].error, /changed elsewhere/i);
    // Server note was untouched and cache got fresh server version
    const fresh = await api(`/api/notes/${n1.id}`);
    assert.equal(fresh.data.parentId, demoId('nb-projects'));
    assert.equal(fresh.data.body, 'Edited elsewhere');
  });

  test('isolates bad ids, encrypted items, missing notes and 500 errors with bounded concurrency', async () => {
    const ok1 = await createTestNote('Mixed OK 1');
    const ok2 = await createTestNote('Mixed OK 2');
    const conflictNote = await createTestNote('Mixed Conflict');
    const encryptedId = demoId('batch-encrypted-note');
    const encProps = {
      id: encryptedId,
      parent_id: demoId('nb-reading'),
      updated_time: new Date().toISOString(),
      deleted_time: '0',
      encryption_applied: '1',
      encryption_cipher_text: 'JED01000022abcd',
    };
    mock.items.set(`${encryptedId}.md`, {
      content: Buffer.from(serialize({ type_: JoplinItemType.Note, properties: encProps }), 'utf8'),
      contentType: 'text/plain; charset=utf-8',
      updatedTime: Date.now(),
    });

    const extraNotes = await Promise.all(
      Array.from({ length: 8 }, (_, i) => createTestNote(`Concurrency ${i}`))
    );

    // Trigger 500 on one specific Joplin Server read by failing after first read or tracking via onItemRequest
    const failTarget = await createTestNote('Mixed 500');
    const badId = '../evil';
    const missingId = demoId('does-not-exist-in-mock');

    let activeReads = 0;
    let maxActiveReads = 0;
    mock.onItemRequest = async ({ method, name }) => {
      if (method === 'GET' && name !== '' && name !== 'info.json') {
        activeReads++;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await new Promise((r) => setTimeout(r, 15));
        activeReads--;
      }
    };

    try {
      // Simulate server edit on conflictNote before calling batch
      const raw = mock.items.get(`${conflictNote.id}.md`)!.content.toString('utf8');
      const parsed = deserialize(raw, `${conflictNote.id}.md`);
      mock.items.set(`${conflictNote.id}.md`, {
        content: Buffer.from(
          serialize({
            type_: JoplinItemType.Note,
            title: parsed.title,
            body: parsed.body,
            properties: { ...parsed.properties, updated_time: new Date(conflictNote.updatedTime + 4000).toISOString() },
          }),
          'utf8'
        ),
        contentType: 'text/plain; charset=utf-8',
        updatedTime: conflictNote.updatedTime + 4000,
      });

      const batchItems = [
        { id: ok1.id, baseUpdatedTime: ok1.updatedTime },
        { id: badId },
        { id: conflictNote.id, baseUpdatedTime: conflictNote.updatedTime },
        { id: missingId },
        { id: demoId('nb-travel') }, // notebook id passed as note id
        { id: encryptedId },
        ...extraNotes.map((n) => ({ id: n.id, baseUpdatedTime: n.updatedTime })),
        { id: ok2.id, baseUpdatedTime: ok2.updatedTime },
      ];

      const res = await api('/api/notes/batch', {
        method: 'POST',
        body: JSON.stringify({ items: batchItems, parentId: demoId('nb-travel') }),
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.length, batchItems.length);
      assert.equal(res.data[0].status, 'ok');
      assert.equal(res.data[1].status, 'error');
      assert.match(res.data[1].error, /Invalid note id/);
      assert.equal(res.data[2].status, 'conflict');
      assert.equal(res.data[3].status, 'error');
      assert.match(res.data[3].error, /Note not found/);
      assert.equal(res.data[4].status, 'error');
      assert.match(res.data[4].error, /not a note/);
      assert.equal(res.data[5].status, 'error');
      assert.match(res.data[5].error, /end-to-end encrypted/);
      for (let i = 6; i < batchItems.length; i++) {
        assert.equal(res.data[i].status, 'ok');
      }
      assert.ok(maxActiveReads <= 4, `concurrency stayed <= 4 (observed ${maxActiveReads})`);

      // Verify a Joplin Server 500 error for one item doesn't abort the batch or leak details.
      // Fail on the next item request once batch item processing starts reading failTarget.
      let injected = false;
      mock.onItemRequest = ({ method, name }) => {
        if (!injected && method === 'GET' && name === `${failTarget.id}.md`) {
          injected = true;
          mock.failNextItemRequests(500, 1);
        }
      };
      const errBatch = await api('/api/notes/batch', {
        method: 'POST',
        body: JSON.stringify({
          items: [{ id: failTarget.id }, { id: ok1.id }],
          trash: true,
        }),
      });
      assert.equal(errBatch.status, 200);
      const errResults = errBatch.data as Array<{ id: string; status: string; error?: string }>;
      const failed = errResults.filter((r) => r.status === 'error');
      const succeeded = errResults.filter((r) => r.status === 'ok');
      assert.equal(failed.length, 1);
      assert.equal(failed[0].error, 'The request to Joplin Server failed');
      assert.doesNotMatch(failed[0].error ?? '', /Injected|127\.0\.0\.1/);
      assert.equal(succeeded.length, 1);
    } finally {
      mock.onItemRequest = null;
      mock.items.delete(`${encryptedId}.md`);
      await api('/api/notebooks/refresh', { method: 'POST' });
    }
  });

  test('adds and removes tags in bulk cleanly, reusing existing tags and creating new tags once', async () => {
    const n1 = await createTestNote('Tag Batch 1');
    const n2 = await createTestNote('Tag Batch 2');
    const trashed = await createTestNote('Tag Batch Trashed');
    await api(`/api/notes/${trashed.id}`, { method: 'DELETE' });

    // Pre-tag n1 with 'planning' (already exists) and 'batch-unique' will be created once across both notes
    await api(`/api/notes/${n1.id}/tags`, { method: 'POST', body: JSON.stringify({ title: 'planning' }) });

    const res = await api('/api/notes/batch', {
      method: 'POST',
      body: JSON.stringify({
        items: [
          { id: n1.id, baseUpdatedTime: n1.updatedTime },
          { id: n2.id, baseUpdatedTime: n2.updatedTime },
          { id: trashed.id },
        ],
        addTags: ['PLANNING', 'batch-unique'],
      }),
    });

    assert.equal(res.status, 200);
    assert.equal(res.data[0].status, 'ok');
    // n1 already had planning, so only batch-unique was newly linked
    assert.deepEqual(res.data[0].addedTags, ['batch-unique']);
    assert.equal(res.data[1].status, 'ok');
    assert.deepEqual(res.data[1].addedTags, ['planning', 'batch-unique']);
    assert.equal(res.data[2].status, 'error');
    assert.match(res.data[2].error, /Note not found/);

    const tagsAfter = await api('/api/tags');
    const createdTags = tagsAfter.data.filter((t: any) => t.title === 'batch-unique');
    assert.equal(createdTags.length, 1, 'concurrent batch created the new tag only once');

    // Undo tag removal preserves pre-existing 'planning' on n1 when only 'batch-unique' is removed
    const removeRes = await api('/api/notes/batch', {
      method: 'POST',
      body: JSON.stringify({
        items: [{ id: n1.id, baseUpdatedTime: res.data[0].updatedTime }],
        removeTags: ['batch-unique'],
      }),
    });
    assert.equal(removeRes.status, 200);
    assert.equal(removeRes.data[0].status, 'ok');
    const n1Detail = await api(`/api/notes/${n1.id}`);
    assert.deepEqual(
      n1Detail.data.tags.map((t: any) => t.title),
      ['planning']
    );
  });

  test('supports per-item parentId, title, and addTags/removeTags merged with top-level tags', async () => {
    const n1 = await createTestNote('Per-item 1', demoId('nb-projects'));
    const n2 = await createTestNote('Per-item 2', demoId('nb-projects'));
    await api(`/api/notes/${n1.id}/tags`, { method: 'POST', body: JSON.stringify({ title: 'planning' }) });

    const applyRes = await api('/api/notes/batch', {
      method: 'POST',
      body: JSON.stringify({
        addTags: ['shared-tag'],
        items: [
          {
            id: n1.id,
            baseUpdatedTime: n1.updatedTime,
            title: '2024-03-11 Acme – Invoice',
            parentId: demoId('nb-travel'),
            addTags: ['PLANNING', 'invoice'],
          },
          {
            id: n2.id,
            baseUpdatedTime: n2.updatedTime,
            title: 'Per-item 2 Renamed',
            addTags: ['notes'],
          },
        ],
      }),
    });

    assert.equal(applyRes.status, 200);
    assert.equal(applyRes.data[0].status, 'ok');
    // n1 already had planning, so only shared-tag + invoice are newly added
    assert.deepEqual(applyRes.data[0].addedTags.sort(), ['invoice', 'shared-tag']);
    assert.equal(applyRes.data[1].status, 'ok');
    assert.deepEqual(applyRes.data[1].addedTags.sort(), ['notes', 'shared-tag']);

    const n1After = await api(`/api/notes/${n1.id}`);
    assert.equal(n1After.data.title, '2024-03-11 Acme – Invoice');
    assert.equal(n1After.data.parentId, demoId('nb-travel'));
    assert.deepEqual(n1After.data.tags.map((t: any) => t.title).sort(), ['invoice', 'planning', 'shared-tag']);

    const n2After = await api(`/api/notes/${n2.id}`);
    assert.equal(n2After.data.title, 'Per-item 2 Renamed');
    assert.equal(n2After.data.parentId, demoId('nb-projects'));
    assert.deepEqual(n2After.data.tags.map((t: any) => t.title).sort(), ['notes', 'shared-tag']);

    // Per-item removeTags preserves n1's pre-existing planning tag
    const undoRes = await api('/api/notes/batch', {
      method: 'POST',
      body: JSON.stringify({
        items: [
          {
            id: n1.id,
            baseUpdatedTime: applyRes.data[0].updatedTime,
            title: 'Per-item 1',
            parentId: demoId('nb-projects'),
            removeTags: applyRes.data[0].addedTags,
          },
        ],
      }),
    });
    assert.equal(undoRes.status, 200);
    assert.equal(undoRes.data[0].status, 'ok');
    const n1Reverted = await api(`/api/notes/${n1.id}`);
    assert.equal(n1Reverted.data.title, 'Per-item 1');
    assert.equal(n1Reverted.data.parentId, demoId('nb-projects'));
    assert.deepEqual(n1Reverted.data.tags.map((t: any) => t.title), ['planning']);
  });

  test('trashes and restores notes in bulk', async () => {
    const n1 = await createTestNote('Bulk Trash 1', demoId('nb-projects'));
    const n2 = await createTestNote('Bulk Trash 2', demoId('nb-projects'));

    const trashRes = await api('/api/notes/batch', {
      method: 'POST',
      body: JSON.stringify({
        items: [
          { id: n1.id, baseUpdatedTime: n1.updatedTime },
          { id: n2.id, baseUpdatedTime: n2.updatedTime },
        ],
        trash: true,
      }),
    });
    assert.equal(trashRes.status, 200);
    assert.deepEqual(
      trashRes.data.map((r: any) => r.status),
      ['ok', 'ok']
    );
    assert.ok((await api(`/api/notes/${n1.id}`)).data.deletedTime > 0);
    assert.ok((await api(`/api/notes/${n2.id}`)).data.deletedTime > 0);

    const restoreRes = await api('/api/notes/batch', {
      method: 'POST',
      body: JSON.stringify({
        items: [
          { id: n1.id, baseUpdatedTime: trashRes.data[0].updatedTime },
          { id: n2.id, baseUpdatedTime: trashRes.data[1].updatedTime },
        ],
        restore: true,
      }),
    });
    assert.equal(restoreRes.status, 200);
    assert.deepEqual(
      restoreRes.data.map((r: any) => r.status),
      ['ok', 'ok']
    );
    assert.equal((await api(`/api/notes/${n1.id}`)).data.deletedTime, 0);
    assert.equal((await api(`/api/notes/${n2.id}`)).data.deletedTime, 0);
  });

  test('enforces batch size cap, validates payload, and blocks E2EE accounts', async () => {
    const tooMany = Array.from({ length: 1001 }, (_, i) => ({ id: `${String(i).padStart(32, '0')}` }));
    const capRes = await api('/api/notes/batch', {
      method: 'POST',
      body: JSON.stringify({ items: tooMany, trash: true }),
    });
    assert.equal(capRes.status, 400);
    assert.match(capRes.data.error, /1000/);

    const emptyRes = await api('/api/notes/batch', {
      method: 'POST',
      body: JSON.stringify({ items: [], trash: true }),
    });
    assert.equal(emptyRes.status, 400);

    const noopRes = await api('/api/notes/batch', {
      method: 'POST',
      body: JSON.stringify({ items: [{ id: demoId('note-roadmap') }] }),
    });
    assert.equal(noopRes.status, 400);

    const seededInfo = mock.items.get('info.json')!;
    mock.items.set('info.json', syncTargetInfoItem(true, Date.now() + 10_000));
    try {
      await api('/api/notebooks/refresh', { method: 'POST' });
      const e2eeRes = await api('/api/notes/batch', {
        method: 'POST',
        body: JSON.stringify({ items: [{ id: demoId('note-roadmap') }], trash: true }),
      });
      assert.equal(e2eeRes.status, 422);
      assert.match(e2eeRes.data.error, /end-to-end encryption/);
    } finally {
      mock.items.set('info.json', seededInfo);
      await api('/api/notebooks/refresh', { method: 'POST' });
    }
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
    assert.match(res.headers.get('content-security-policy') ?? '', /\bsandbox\b/);
  });

  test('serves PDF attachments inline without sandbox and allows only same-origin framing', async () => {
    const id = await upload('report.pdf', 'application/pdf', '%PDF-1.4\n%');
    const res = await api(`/api/resources/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.match(res.headers.get('content-disposition') ?? '', /^inline; filename="report\.pdf"/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'self'/);
    assert.doesNotMatch(csp, /\bsandbox\b/);

    // Sniffed PDF uploads (when upstream omits type) get the same inline type and CSP
    const sniffedId = await upload('scan', 'application/octet-stream', '%PDF-1.7\n');
    const sniffedRes = await api(`/api/resources/${sniffedId}`);
    assert.equal(sniffedRes.headers.get('content-type'), 'application/pdf');
    assert.match(sniffedRes.headers.get('content-disposition') ?? '', /^inline; filename="scan"/);
    assert.doesNotMatch(sniffedRes.headers.get('content-security-policy') ?? '', /\bsandbox\b/);
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
    const { resourceCsp, resourceResponseType } = await import('../src/routes/resources.js');
    assert.deepEqual(resourceResponseType('application/pdf'), { contentType: 'application/pdf', inline: true });
    assert.deepEqual(resourceResponseType('video/mp4'), { contentType: 'video/mp4', inline: true });
    assert.deepEqual(resourceResponseType('IMAGE/PNG; charset=x'), { contentType: 'image/png', inline: true });
    assert.deepEqual(resourceResponseType('audio/x\r\nX-Evil: 1'), { contentType: 'application/octet-stream', inline: false });
    assert.deepEqual(resourceResponseType(undefined), { contentType: 'application/octet-stream', inline: false });

    assert.equal(
      resourceCsp('APPLICATION/PDF; charset=binary'),
      "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'"
    );
    assert.match(resourceCsp('image/svg+xml'), /\bsandbox\b/);
    assert.match(resourceCsp('image/png'), /\bsandbox\b/);
    assert.match(resourceCsp('application/octet-stream'), /\bsandbox\b/);
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

  test('validates AI_* config and disables organize by default when unset', async () => {
    const { loadConfig, ConfigError } = await import('../src/config.js');
    const base = { JOPLIN_SERVER_URL: 'https://notes.example.com' };
    assert.equal(loadConfig(base).aiBaseUrl, null);
    assert.equal(loadConfig(base).aiModel, null);
    assert.equal(loadConfig(base).aiConcurrency, 4);

    assert.throws(() => loadConfig({ ...base, AI_BASE_URL: 'ftp://bad.test' }), ConfigError);
    assert.throws(() => loadConfig({ ...base, AI_BASE_URL: 'https://user:pw@ai.test/v1' }), ConfigError);
    assert.throws(() => loadConfig({ ...base, AI_CONCURRENCY: '0' }), ConfigError);

    const statusRes = await api('/api/organize/status');
    assert.equal(statusRes.status, 200);
    assert.deepEqual(statusRes.data, { enabled: false });

    const startRes = await api('/api/organize/jobs', {
      method: 'POST',
      body: JSON.stringify({ noteIds: [demoId('note-roadmap')] }),
    });
    assert.equal(startRes.status, 503);

    const listRes = await api('/api/organize/jobs');
    assert.equal(listRes.status, 200);
    assert.deepEqual(listRes.data, { jobs: [] });

    const retryRes = await api(`/api/organize/jobs/${'a'.repeat(32)}/retry`, { method: 'POST' });
    assert.equal(retryRes.status, 503);
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
