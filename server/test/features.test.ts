import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { buildDemoItems, DEMO_EMAIL, DEMO_PASSWORD, demoId } from '../demo/seed.js';
import { extractInlineTasks, setInlineTaskChecked } from '../src/services/inline-tasks.js';
import { applyPatchText, reconstructRevisionContent } from '../src/services/revision-patch.js';
import { JoplinItemType } from '../src/types/index.js';
import { mockItem, putMockItem, startTestApp, type TestApp } from './helpers.js';

describe('extended workspace API integration', () => {
  let app: TestApp;
  let cacheDir: string;
  const rev1Id = demoId('feature-rev-1');
  const rev2Id = demoId('feature-rev-2');
  const revTargetNoteId = demoId('note-lisbon');
  const dupNoteA = demoId('dup-note-a');
  const dupNoteB = demoId('dup-note-b');
  const emptyNoteId = demoId('empty-note');
  const untaggedInlineTaskNoteId = demoId('inline-task-note');
  const audioResId = demoId('audio-res');
  const audioNoteId = demoId('audio-note');

  before(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), 'joplin-feat-cache-'));
    process.env.AI_FAKE = 'true';
    process.env.EMAIL_INGEST_WEBHOOK_SECRET = 'test-webhook-secret';
    process.env.EMAIL_INGEST_JOPLIN_EMAIL = DEMO_EMAIL;
    process.env.EMAIL_INGEST_JOPLIN_PASSWORD = DEMO_PASSWORD;

    const items = buildDemoItems();
    app = await startTestApp({ items, cacheDir, cacheTtlMs: 0 });
    await app.login();

    const now = Date.now();
    putMockItem(
      app.mock,
      {
        id: untaggedInlineTaskNoteId,
        type_: JoplinItemType.Note,
        title: 'Sprint Checklist',
        body: [
          'See [Lisbon trip](:/' + revTargetNoteId + ') for context.',
          '',
          '- [ ] Ship tasks hub',
          '- [x] Verify backend routes',
        ].join('\n'),
        parent_id: demoId('nb-work'),
        createdTime: now,
        updatedTime: now,
        properties: {
          source_url: 'https://github.com/example/repo',
          author: 'Jimmy',
        },
      },
      now
    );

    app.mock.items.set(`${audioResId}.md`, {
      content: Buffer.from(
        [
          'Voice Memo.m4a',
          '',
          `id: ${audioResId}`,
          'mime: audio/mp4',
          'filename: Voice Memo.m4a',
          'file_extension: m4a',
          'size: 4',
          'type_: 4',
          `updated_time: ${now}`,
          `created_time: ${now}`,
        ].join('\n'),
        'utf8'
      ),
      contentType: 'text/plain; charset=utf-8',
      updatedTime: now,
    });
    app.mock.items.set(`.resource/${audioResId}`, {
      content: Buffer.from('M4AA', 'utf8'),
      contentType: 'audio/mp4',
      updatedTime: now,
    });
    putMockItem(
      app.mock,
      {
        id: audioNoteId,
        type_: JoplinItemType.Note,
        title: 'Audio Standup',
        body: `Recording attached: [Voice Memo.m4a](:/${audioResId})`,
        parent_id: demoId('nb-work'),
        createdTime: now - 10_000,
        updatedTime: now - 10_000,
        properties: {
          source_url: 'https://meet.example.com/123',
        },
      },
      now - 10_000
    );

    putMockItem(
      app.mock,
      {
        id: dupNoteA,
        type_: JoplinItemType.Note,
        title: 'Weekly Review',
        body: 'Review sprint metrics and open tickets.',
        parent_id: demoId('nb-work'),
        createdTime: now - 20_000,
        updatedTime: now - 20_000,
      },
      now - 20_000
    );
    putMockItem(
      app.mock,
      {
        id: dupNoteB,
        type_: JoplinItemType.Note,
        title: 'Weekly Review',
        body: 'Review sprint metrics and open tickets.',
        parent_id: demoId('nb-work'),
        createdTime: now - 30_000,
        updatedTime: now - 30_000,
      },
      now - 30_000
    );
    putMockItem(
      app.mock,
      {
        id: emptyNoteId,
        type_: JoplinItemType.Note,
        title: 'Blank Placeholder',
        body: '',
        parent_id: demoId('nb-work'),
        createdTime: now - 40_000,
        updatedTime: now - 40_000,
      },
      now - 40_000
    );

    putMockItem(
      app.mock,
      {
        id: rev1Id,
        type_: JoplinItemType.Revision,
        title: '',
        parent_id: '',
        createdTime: now - 200_000,
        updatedTime: now - 200_000,
        properties: {
          item_type: String(JoplinItemType.Note),
          item_id: revTargetNoteId,
          item_updated_time: String(now - 200_000),
          title_diff: '@@ -0,0 +1,9 @@\n+Lisbon%20v1',
          body_diff: '@@ -0,0 +1,16 @@\n+Original%20packing',
        },
      },
      now - 200_000
    );
    putMockItem(
      app.mock,
      {
        id: rev2Id,
        type_: JoplinItemType.Revision,
        title: '',
        parent_id: rev1Id,
        createdTime: now - 100_000,
        updatedTime: now - 100_000,
        properties: {
          item_type: String(JoplinItemType.Note),
          item_id: revTargetNoteId,
          item_updated_time: String(now - 100_000),
          title_diff: '@@ -7,3 +7,3 @@\n %20v\n-1\n+2',
          body_diff: '@@ -9,8 +9,21 @@\n %20packing\n+%0A+%20Passport',
        },
      },
      now - 100_000
    );
  });

  after(async () => {
    await app.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  test('preferences shortcuts, recent reads, scratchpad, and /api/notes/recent', async () => {
    const prefEmpty = await app.api('/api/preferences');
    assert.equal(prefEmpty.status, 200);
    assert.deepEqual(prefEmpty.data.favoriteNoteIds, []);

    const favRes = await app.api(`/api/preferences/favorites/notes/${revTargetNoteId}`, { method: 'POST' });
    assert.equal(favRes.status, 200);
    assert.ok(favRes.data.favoriteNotes.some((n: any) => n.id === revTargetNoteId));

    const favNbRes = await app.api(`/api/preferences/favorites/notebooks/${demoId('nb-work')}`, { method: 'POST' });
    assert.equal(favNbRes.status, 200);
    assert.ok(favNbRes.data.favoriteNotebooks.some((n: any) => n.id === demoId('nb-work')));

    const savedSearch = await app.api('/api/preferences/saved-searches', {
      method: 'POST',
      body: JSON.stringify({ name: 'Untagged Work', query: 'tag:none notebook:Work' }),
    });
    assert.equal(savedSearch.status, 201);
    assert.equal(savedSearch.data.name, 'Untagged Work');

    const pad = await app.api('/api/preferences/scratchpad', {
      method: 'PUT',
      body: JSON.stringify({ scratchpad: 'Remember to buy coffee' }),
    });
    assert.equal(pad.status, 200);
    assert.equal(pad.data.scratchpad, 'Remember to buy coffee');

    const read1 = await app.api(`/api/preferences/recent-reads/${audioNoteId}`, { method: 'POST' });
    assert.equal(read1.status, 204);
    const read2 = await app.api(`/api/preferences/recent-reads/${revTargetNoteId}`, { method: 'POST' });
    assert.equal(read2.status, 204);

    const recent = await app.api('/api/notes/recent');
    assert.equal(recent.status, 200);
    assert.deepEqual(
      recent.data.recentRead.slice(0, 2).map((n: any) => n.id),
      [revTargetNoteId, audioNoteId]
    );
    assert.ok(Array.isArray(recent.data.recentCreated) && recent.data.recentCreated.length > 0);
  });

  test('note detail includes ancestor notebookPath & backlinks', async () => {
    const res = await app.api(`/api/notes/${revTargetNoteId}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.notebookPath) && res.data.notebookPath.length >= 1);
    assert.ok(res.data.backlinks.some((b: any) => b.id === untaggedInlineTaskNoteId));
  });

  test('rich search filters work end-to-end (tag:none, has:attachment, sourceurl:)', async () => {
    const tagNone = await app.api('/api/search?q=' + encodeURIComponent('tag:none notebook:Work'));
    assert.equal(tagNone.status, 200);
    assert.ok(tagNone.data.some((n: any) => n.id === untaggedInlineTaskNoteId));

    const hasAtt = await app.api('/api/search?q=' + encodeURIComponent('has:attachment Audio'));
    assert.equal(hasAtt.status, 200);
    assert.ok(hasAtt.data.some((n: any) => n.id === audioNoteId));

    const bySource = await app.api('/api/search?q=' + encodeURIComponent('sourceurl:github.com'));
    assert.equal(bySource.status, 200);
    assert.equal(bySource.data.length, 1);
    assert.equal(bySource.data[0].id, untaggedInlineTaskNoteId);
  });

  test('attachments inspector & audio resource MIME streaming', async () => {
    const attRes = await app.api(`/api/notes/${audioNoteId}/attachments`);
    assert.equal(attRes.status, 200);
    assert.equal(attRes.data.length, 1);
    assert.equal(attRes.data[0].kind, 'audio');
    assert.equal(attRes.data[0].filename, 'Voice Memo.m4a');

    const streamRes = await fetch(`${app.baseUrl}/api/resources/${audioResId}`, {
      headers: { Authorization: `Bearer ${app.session}` },
    });
    assert.equal(streamRes.status, 200);
    assert.equal(streamRes.headers.get('content-type'), 'audio/mp4');
  });

  test('revisions list, detail reconstruction, and restore flow', async () => {
    const listRes = await app.api(`/api/notes/${revTargetNoteId}/revisions`);
    assert.equal(listRes.status, 200);
    assert.equal(listRes.data.length, 2);

    const detailRes = await app.api(`/api/notes/${revTargetNoteId}/revisions/${rev2Id}`);
    assert.equal(detailRes.status, 200);
    assert.equal(detailRes.data.title, 'Lisbon v2');
    assert.ok(detailRes.data.body.includes('+ Passport'));

    const restoreRes = await app.api(`/api/notes/${revTargetNoteId}/revisions/${rev1Id}/restore`, {
      method: 'POST',
    });
    assert.equal(restoreRes.status, 200);
    assert.equal(restoreRes.data.title, 'Lisbon v1');
    assert.equal(restoreRes.data.body, 'Original packing');
  });

  test('tasks hub lists todo notes & inline checklists and toggles inline checkboxes atomically', async () => {
    const listRes = await app.api('/api/tasks');
    assert.equal(listRes.status, 200);
    assert.ok(Array.isArray(listRes.data.todoNotes));
    const inline = listRes.data.inlineTasks.find(
      (t: any) => t.noteId === untaggedInlineTaskNoteId && t.text === 'Ship tasks hub'
    );
    assert.ok(inline);
    assert.equal(inline.checked, false);

    const stale = await app.api('/api/tasks/toggle', {
      method: 'POST',
      body: JSON.stringify({
        noteId: untaggedInlineTaskNoteId,
        line: inline.line,
        column: inline.column,
        checked: true,
        baseUpdatedTime: 1,
      }),
    });
    assert.equal(stale.status, 409);

    const toggle = await app.api('/api/tasks/toggle', {
      method: 'POST',
      body: JSON.stringify({
        noteId: untaggedInlineTaskNoteId,
        line: inline.line,
        column: inline.column,
        checked: true,
        baseUpdatedTime: inline.updatedTime,
      }),
    });
    assert.equal(toggle.status, 200);
    assert.ok(toggle.data.body.includes('- [x] Ship tasks hub'));
  });

  test('hygiene report detects duplicate clusters, empty notes & untagged notes', async () => {
    const res = await app.api('/api/organize/hygiene');
    assert.equal(res.status, 200);
    assert.ok(res.data.duplicateClusters.some((c: any) => c.notes.some((n: any) => n.id === dupNoteA)));
    assert.ok(res.data.emptyNotes.some((n: any) => n.id === emptyNoteId));
    assert.ok(res.data.untaggedNotes.some((n: any) => n.id === untaggedInlineTaskNoteId));
  });

  test('AI Ask Notes and Note Assist work in AI_FAKE mode', async () => {
    const status = await app.api('/api/ai/status');
    assert.equal(status.status, 200);
    assert.equal(status.data.enabled, true);

    const ask = await app.api('/api/ai/ask', {
      method: 'POST',
      body: JSON.stringify({ question: 'Which notes discuss audio standup?' }),
    });
    assert.equal(ask.status, 200);
    assert.ok(typeof ask.data.answer === 'string' && ask.data.answer.length > 0);
    assert.ok(Array.isArray(ask.data.citations) && ask.data.citations.length > 0);

    const assist = await app.api('/api/ai/note-assist', {
      method: 'POST',
      body: JSON.stringify({ noteId: audioNoteId, action: 'suggest-tags' }),
    });
    assert.equal(assist.status, 200);
    assert.ok(Array.isArray(assist.data.tags) && assist.data.tags.length > 0);
  });

  test('clip route enforces SSRF, email import creates note, and webhook checks secret', async () => {
    const ssrf = await app.api('/api/clip', {
      method: 'POST',
      body: JSON.stringify({ url: 'http://127.0.0.1:9999/internal' }),
    });
    assert.equal(ssrf.status, 400);

    const emailNote = await app.api('/api/integrations/email', {
      method: 'POST',
      body: JSON.stringify({
        raw: [
          'From: billing@example.com',
          'Subject: Cloud Invoice #900',
          'Content-Type: text/plain; charset="utf-8"',
          '',
          'Amount due: $19.00',
        ].join('\r\n'),
      }),
    });
    assert.equal(emailNote.status, 201);
    assert.equal(emailNote.data.note.title, 'Cloud Invoice #900');

    const badHook = await app.api(
      '/api/webhooks/email',
      {
        method: 'POST',
        headers: { 'X-Webhook-Secret': 'wrong-secret' },
        body: JSON.stringify({ subject: 'Fail', text: 'nope' }),
      },
      false
    );
    assert.equal(badHook.status, 401);

    const okHook = await app.api(
      '/api/webhooks/email',
      {
        method: 'POST',
        headers: { 'X-Webhook-Secret': 'test-webhook-secret' },
        body: JSON.stringify({ subject: 'Webhook Ticket', from: 'ops@example.com', text: 'Server rebooted cleanly.' }),
      },
      false
    );
    assert.equal(okHook.status, 201);
    assert.equal(okHook.data.note.title, 'Webhook Ticket');
    assert.ok(mockItem(app.mock, okHook.data.note.id));
  });
});

describe('pure feature services', () => {
  test('inline task extractor skips code fences/comments and toggles specific line/column', () => {
    const md = [
      '# Meeting Notes',
      '- [ ] Send recap email',
      '```markdown',
      '- [ ] Ignore inside fence',
      '```',
      '<!-- - [ ] Ignore inside comment -->',
      '  * [x] Archive slides',
    ].join('\n');

    const tasks = extractInlineTasks(md);
    assert.equal(tasks.length, 2);
    assert.deepEqual(tasks[0], { line: 2, column: 1, text: 'Send recap email', checked: false });
    assert.deepEqual(tasks[1], { line: 7, column: 3, text: 'Archive slides', checked: true });

    const toggled = setInlineTaskChecked(md, 2, 1, true);
    assert.ok(toggled);
    assert.ok(toggled.includes('- [x] Send recap email'));
    assert.ok(toggled.includes('- [ ] Ignore inside fence'));
    assert.equal(setInlineTaskChecked(md, 99, 1, true), null);
  });

  test('revision patch parser reconstructs GNU unidiff & JSON patch revision chains', () => {
    const baseBody = applyPatchText('', '@@ -0,0 +1,11 @@\n+Hello%20world');
    assert.equal(baseBody, 'Hello world');

    const rev1Id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const rev2Id = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const records = [
      {
        id: rev1Id,
        parentId: '',
        updatedTime: 1000,
        titleUpdatedTime: 1000,
        titleDiff: '@@ -0,0 +1,7 @@\n+Draft%201',
        bodyDiff: '@@ -0,0 +1,11 @@\n+First%20line.',
      },
      {
        id: rev2Id,
        parentId: rev1Id,
        updatedTime: 2000,
        titleUpdatedTime: 2000,
        titleDiff: JSON.stringify([
          {
            diffs: [
              [0, 'Draft '],
              [-1, '1'],
              [1, '2'],
            ],
            start1: 0,
            start2: 0,
            length1: 7,
            length2: 7,
          },
        ]),
        bodyDiff: '@@ -7,5 +7,14 @@\n line.\n+%0ASecond%20line.',
      },
    ];

    const v1 = reconstructRevisionContent(records, rev1Id);
    assert.deepEqual(v1, { title: 'Draft 1', body: 'First line.' });

    const v2 = reconstructRevisionContent(records, rev2Id);
    assert.deepEqual(v2, { title: 'Draft 2', body: 'First line.\nSecond line.' });
  });

  test('web clipper enforces SSRF blocks on private/loopback/metadata IPs & extracts Readability markdown', async () => {
    const { fetchAndClipUrl } = await import('../src/services/web-clipper.js');
    await assert.rejects(
      () => fetchAndClipUrl('http://127.0.0.1:8080/secret'),
      (err: any) => err?.status === 400
    );
    await assert.rejects(
      () => fetchAndClipUrl('http://localhost/admin'),
      (err: any) => err?.status === 400
    );
    await assert.rejects(
      () => fetchAndClipUrl('http://169.254.169.254/latest/meta-data/'),
      (err: any) => err?.status === 400
    );
    await assert.rejects(
      () => fetchAndClipUrl('file:///etc/passwd'),
      (err: any) => err?.status === 400
    );

    await assert.rejects(
      () =>
        fetchAndClipUrl('https://rebind.example.com/post', {
          dnsLookup: async () => [{ address: '10.0.0.5', family: 4 }],
        }),
      (err: any) => err?.status === 400
    );

    await assert.rejects(
      () =>
        fetchAndClipUrl('https://public.example.com/start', {
          dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
          fetchFn: async () =>
            new Response('', {
              status: 302,
              headers: { location: 'http://192.168.1.1/router' },
            }),
        }),
      (err: any) => err?.status === 400
    );

    const clipped = await fetchAndClipUrl('https://article.example.com/post', {
      dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchFn: async () =>
        new Response(
          `<!doctype html><html><head><title>Ignored Title</title><meta property="og:title" content="How Joplin Syncs"></head><body><article><h1>How Joplin Syncs</h1><p>Read <a href="/docs/spec">the specification</a> cleanly.</p><script>alert(1)</script></article></body></html>`,
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }
        ),
    });
    assert.equal(clipped.title, 'How Joplin Syncs');
    assert.ok(clipped.markdown.includes('https://article.example.com/docs/spec'));
    assert.ok(!clipped.markdown.includes('alert(1)'));
  });

  test('parseEmlMessage extracts headers and decodes body', async () => {
    const { parseEmlMessage } = await import('../src/services/web-clipper.js');
    const eml = [
      'From: Alice <alice@example.com>',
      'Subject: Quarterly Receipt',
      'Date: Mon, 18 Nov 2026 10:00:00 +0000',
      'Content-Type: text/plain; charset="utf-8"',
      '',
      'Attached total is $42.50.',
    ].join('\r\n');
    const parsed = parseEmlMessage(eml);
    assert.equal(parsed.subject, 'Quarterly Receipt');
    assert.equal(parsed.from, 'Alice <alice@example.com>');
    assert.ok(parsed.markdownBody.includes('$42.50'));
  });

  test('PreferencesStore persists per-owner shortcuts, recent reads & scratchpad atomically', async () => {
    const { PreferencesStore } = await import('../src/services/preferences-store.js');
    const dir = mkdtempSync(join(tmpdir(), 'joplin-prefs-'));
    try {
      const store1 = new PreferencesStore(dir);
      const n1 = '11111111111111111111111111111111';
      const n2 = '22222222222222222222222222222222';
      await store1.addFavoriteNote('user-test', n1);
      await store1.addFavoriteNotebook('user-test', n2);
      const ss = await store1.addSavedSearch('user-test', 'Untagged', 'tag:none');
      await store1.recordRecentRead('user-test', n1);
      await store1.recordRecentRead('user-test', n2);
      await store1.recordRecentRead('user-test', n1);
      await store1.setScratchpad('user-test', 'Quick thought');

      const store2 = new PreferencesStore(dir);
      const loaded = store2.get('user-test');
      assert.deepEqual(loaded.favoriteNoteIds, [n1]);
      assert.deepEqual(loaded.favoriteNotebookIds, [n2]);
      assert.equal(loaded.savedSearches.length, 1);
      assert.equal(loaded.savedSearches[0].id, ss.id);
      assert.deepEqual(
        loaded.recentReads.map((r) => r.noteId),
        [n1, n2]
      );
      assert.equal(loaded.scratchpad, 'Quick thought');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
