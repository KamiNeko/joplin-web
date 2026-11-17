import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { buildDemoItems, demoId } from '../demo/seed.js';
import { JoplinItemType } from '../src/types/index.js';
import { putMockItem, startTestApp, type TestApp } from './helpers.js';

/**
 * Search and attachment text extraction over resource OCR (`ocr_text` + `ocr_status: 2`),
 * including delta updates and on-disk cache v2 persistence / v1 migration rebuilds.
 */

const cacheDir = mkdtempSync(join(tmpdir(), 'joplin-web-ocr-test-'));
const HOUR = 60 * 60 * 1000;
const NOW = Date.now();

const resPdfDone = demoId('ocr-res-pdf-done');
const resPngDone = demoId('ocr-res-png-done');
const resHtmlImg = demoId('ocr-res-html-img');
const resPending = demoId('ocr-res-pending');
const resQueued = demoId('ocr-res-queued');
const resFailed = demoId('ocr-res-failed');
const resNoStatus = demoId('ocr-res-no-status');
const resDelta = demoId('ocr-res-delta');

const noteMarkdownMulti = demoId('ocr-note-md-multi');
const noteHtmlClip = demoId('ocr-note-html-clip');
const noteTodoOpen = demoId('ocr-note-todo-open');
const noteNonDone = demoId('ocr-note-non-done');
const noteMixedTitle = demoId('ocr-note-mixed-title');
const noteEncrypted = demoId('ocr-note-encrypted');
const noteTrashed = demoId('ocr-note-trashed');
const noteConflict = demoId('ocr-note-conflict');
const noteDelta = demoId('ocr-note-delta');
const tagFinance = demoId('ocr-tag-finance');

let app: TestApp;
let cacheModule: typeof import('../src/services/note-cache.js');
let session: string;

const api = (path: string, init: RequestInit = {}) => app.api(path, init);

function seedOcrItems() {
  return buildDemoItems(NOW);
}

before(async () => {
  const items = seedOcrItems();
  const putRawItem = (item: Parameters<typeof putMockItem>[1]) => {
    const mockAdapter = {
      items,
      recordChange: () => undefined,
    } as unknown as Parameters<typeof putMockItem>[0];
    putMockItem(mockAdapter, item);
  };

  const addRes = (id: string, title: string, mime: string, props: Record<string, string>) =>
    putRawItem({
      type_: JoplinItemType.Resource,
      id,
      title,
      createdTime: NOW - HOUR,
      updatedTime: NOW - HOUR,
      properties: { mime, filename: title, size: '256', encryption_applied: '0', ...props },
    });

  // ocr_status = 2 (done) resources
  addRes(resPdfDone, 'scan_01.pdf', 'application/pdf', {
    ocr_status: '2',
    ocr_text: 'Merchant: Harborview\nHardware Co.\nItem: Titanium Wrench #42\nSubtotal: $89.50',
    ocr_details: '{"words":[{"text":"Harborview","box":[0,0,10,10]}]}',
  });
  addRes(resPngDone, 'receipt_02.png', 'image/png', {
    ocr_status: '2',
    ocr_text: 'Payment Method: Sapphire Card\nAuthorization Code: AUTH-99182\nLocation: Lisbon Wharf',
  });
  addRes(resHtmlImg, 'clipped_chart.jpg', 'image/jpeg', {
    ocr_status: '2',
    ocr_text: 'Quarterly Widget Telemetry Report\nP99 Latency: 18 ms across Zurich Cluster',
  });

  // Non-done resources whose ocr_text must be ignored
  addRes(resPending, 'pending.pdf', 'application/pdf', { ocr_status: '0', ocr_text: 'UnsearchableStatusZero' });
  addRes(resQueued, 'processing.pdf', 'application/pdf', { ocr_status: '1', ocr_text: 'UnsearchableStatusOne' });
  addRes(resFailed, 'failed.pdf', 'application/pdf', { ocr_status: '3', ocr_text: 'UnsearchableStatusThree' });
  addRes(resNoStatus, 'missing_status.pdf', 'application/pdf', { ocr_text: 'UnsearchableMissingStatus' });

  // Delta-updated resource: starts as status 1 (not searchable yet)
  addRes(resDelta, 'delta_scan.pdf', 'application/pdf', { ocr_status: '1', ocr_text: 'NotReadyBeforeDelta' });

  // Tag for filter + OCR test
  putRawItem({
    type_: JoplinItemType.Tag,
    id: tagFinance,
    title: 'finance-ocr',
    createdTime: NOW - HOUR,
    updatedTime: NOW - HOUR,
    properties: { encryption_applied: '0' },
  });

  // Markdown note linking two OCR resources + another note (note link should be skipped by attachment text helper) + repeated link
  putRawItem({
    type_: JoplinItemType.Note,
    id: noteMarkdownMulti,
    title: '2024_04_02.pdf',
    body: [
      `First: [scan_01.pdf](:/${resPdfDone.toUpperCase()} "Scan")`,
      `Note ref: [Roadmap](:/${demoId('note-roadmap')})`,
      `Second: ![receipt](:/${resPngDone})`,
      `Duplicate: [again](:/${resPdfDone}#page=1)`,
    ].join('\n\n'),
    parentId: demoId('nb-projects'),
    createdTime: NOW - 2 * HOUR,
    updatedTime: NOW - 2 * HOUR,
    properties: { deleted_time: '0', encryption_applied: '0', is_todo: '0' },
  });
  putRawItem({
    type_: JoplinItemType.NoteTag,
    id: demoId('ocr-link-md-finance'),
    createdTime: NOW - 2 * HOUR,
    updatedTime: NOW - 2 * HOUR,
    properties: { note_id: noteMarkdownMulti, tag_id: tagFinance },
  });

  // HTML note linking resource with <img>
  putRawItem({
    type_: JoplinItemType.Note,
    id: noteHtmlClip,
    title: 'Web Clip Scan',
    body: `<div class="clip"><p>Clipped page</p><img src=":/${resHtmlImg}" alt="chart"></div>`,
    parentId: demoId('nb-reading'),
    createdTime: NOW - 3 * HOUR,
    updatedTime: NOW - 3 * HOUR,
    properties: { deleted_time: '0', encryption_applied: '0', markup_language: '2', is_todo: '0' },
  });

  // Open to-do with HTML <a> link to OCR resource (for type:todo & iscompleted:0 filter + OCR)
  putRawItem({
    type_: JoplinItemType.Note,
    id: noteTodoOpen,
    title: 'File reimbursement',
    body: `Attached PDF: <a href=':/${resPdfDone}'>scan_01.pdf</a>`,
    parentId: demoId('nb-work'),
    createdTime: NOW - HOUR,
    updatedTime: NOW - HOUR,
    isTodo: true,
    todoCompleted: 0,
    properties: { deleted_time: '0', encryption_applied: '0', is_todo: '1', todo_completed: '0' },
  });

  // Note linking only non-2 OCR resources
  putRawItem({
    type_: JoplinItemType.Note,
    id: noteNonDone,
    title: 'Pending OCR batch',
    body: `[pending](:/${resPending}) [proc](:/${resQueued}) [err](:/${resFailed}) [none](:/${resNoStatus})`,
    parentId: demoId('nb-work'),
    createdTime: NOW - HOUR,
    updatedTime: NOW - HOUR,
    properties: { deleted_time: '0', encryption_applied: '0', is_todo: '0' },
  });

  // Note whose title matches "Harborview" directly (tests ranking: title > body > attachment-only, and matchedIn unset)
  putRawItem({
    type_: JoplinItemType.Note,
    id: noteMixedTitle,
    title: 'Harborview Note',
    body: `[scan](:/${resPdfDone})`,
    parentId: demoId('nb-work'),
    createdTime: NOW - 4 * HOUR,
    updatedTime: NOW - 4 * HOUR,
    properties: { deleted_time: '0', encryption_applied: '0', is_todo: '0' },
  });

  // Encrypted note linking resource (must not match or leak attachment text)
  putRawItem({
    type_: JoplinItemType.Note,
    id: noteEncrypted,
    title: '',
    body: `[hidden](:/${resPdfDone})`,
    parentId: demoId('nb-work'),
    createdTime: NOW - HOUR,
    updatedTime: NOW - HOUR,
    properties: { deleted_time: '0', encryption_applied: '1', encryption_cipher_text: 'JED01abc' },
  });

  // Trashed note & conflict copy linking resource (both excluded from search)
  putRawItem({
    type_: JoplinItemType.Note,
    id: noteTrashed,
    title: 'Trashed scan note',
    body: `[scan](:/${resPdfDone})`,
    parentId: demoId('nb-work'),
    createdTime: NOW - HOUR,
    updatedTime: NOW - HOUR,
    properties: { deleted_time: String(NOW - 1000), encryption_applied: '0' },
  });
  putRawItem({
    type_: JoplinItemType.Note,
    id: noteConflict,
    title: 'Conflict scan note',
    body: `[scan](:/${resPdfDone})`,
    parentId: demoId('nb-work'),
    createdTime: NOW - HOUR,
    updatedTime: NOW - HOUR,
    properties: { deleted_time: '0', encryption_applied: '0', is_conflict: '1' },
  });

  // Note for delta test
  putRawItem({
    type_: JoplinItemType.Note,
    id: noteDelta,
    title: 'scanner_img_009.pdf',
    body: `[delta](:/${resDelta})`,
    parentId: demoId('nb-work'),
    createdTime: NOW - HOUR,
    updatedTime: NOW - HOUR,
    properties: { deleted_time: '0', encryption_applied: '0' },
  });

  app = await startTestApp({ items, delta: true, cacheDir });
  cacheModule = await import('../src/services/note-cache.js');
  session = await app.login();
});

after(async () => {
  await app.close();
  rmSync(cacheDir, { recursive: true, force: true });
});

describe('OCR search', () => {
  test('matches Markdown and HTML attachment links via OCR only and generates snippet without stripping punctuation', async () => {
    const mdRes = await api('/api/search?q=Sapphire%20AUTH-99182');
    assert.equal(mdRes.status, 200);
    assert.deepEqual(mdRes.data.map((n: any) => n.id), [noteMarkdownMulti]);
    assert.equal(mdRes.data[0].matches.inTitle, false);
    assert.equal(mdRes.data[0].matches.inBody, false);
    assert.equal(mdRes.data[0].matches.matchedIn, 'attachment');
    assert.deepEqual(mdRes.data[0].matches.terms, ['sapphire', 'auth-99182']);
    assert.match(mdRes.data[0].matches.snippet, /AUTH-99182/);

    // Preserves '#' / '$' punctuation instead of running stripMarkdown over plain OCR text
    const punctRes = await api('/api/search?q=%22%2342%22%20%22%2489.50%22');
    assert.equal(punctRes.status, 200);
    const mdHit = punctRes.data.find((n: any) => n.id === noteMarkdownMulti);
    assert.ok(mdHit);
    assert.equal(mdHit.matches.matchedIn, 'attachment');
    assert.ok(mdHit.matches.snippet.includes('#42') && mdHit.matches.snippet.includes('$89.50'));

    // HTML note with <img> resource link
    const htmlRes = await api('/api/search?q=%22Zurich%20Cluster%22');
    assert.equal(htmlRes.status, 200);
    assert.deepEqual(htmlRes.data.map((n: any) => n.id), [noteHtmlClip]);
    assert.equal(htmlRes.data[0].matches.matchedIn, 'attachment');
    assert.match(htmlRes.data[0].matches.snippet, /Zurich Cluster/);
  });

  test('matches words across multiple attachments, allows wrapped phrases in one, and rejects phrases spanning attachments', async () => {
    // Word 1 in first attachment, Word 2 in second attachment
    const cross = await api('/api/search?q=Titanium%20Sapphire');
    assert.deepEqual(cross.data.map((n: any) => n.id), [noteMarkdownMulti]);
    assert.equal(cross.data[0].matches.matchedIn, 'attachment');
    // Snippet comes from the earliest matching term in link order (first attachment)
    assert.match(cross.data[0].matches.snippet, /Titanium/);

    // Exact phrase across a newline inside one attachment
    const wrappedPhrase = await api('/api/search?q=%22Harborview%20Hardware%22');
    const foundIds = wrappedPhrase.data.map((n: any) => n.id);
    assert.ok(foundIds.includes(noteMarkdownMulti));

    // Title match outranks newer attachment-only matches (score 100 vs 1)
    const ranked = await api('/api/search?q=Harborview');
    assert.equal(ranked.data[0].id, noteMixedTitle);
    assert.equal(ranked.data[0].matches.inTitle, true);
    assert.equal(ranked.data[0].matches.matchedIn, undefined);
    assert.equal(ranked.data[1].matches.matchedIn, 'attachment');

    // Adjacent text across attachment 1 end ("$89.50") -> attachment 2 start ("Payment") must NOT match as one phrase
    const spanRes = await api('/api/search?q=%2289.50%20Payment%22');
    assert.deepEqual(spanRes.data, []);
  });

  test('applies excluded terms (-word and -"phrase") to attachment OCR text', async () => {
    // "Harborview" in first attachment; "Sapphire" in second attachment excludes noteMarkdownMulti only
    const res = await api('/api/search?q=Harborview%20-Sapphire');
    const ids = res.data.map((n: any) => n.id);
    assert.ok(ids.includes(noteTodoOpen));
    assert.ok(!ids.includes(noteMarkdownMulti), 'excluded by term inside second attachment OCR');

    // Excluded term removes title-matched note when its attachment contains the excluded phrase
    const titleExcluded = await api('/api/search?q=Harborview%20-%22Titanium%20Wrench%22');
    assert.deepEqual(titleExcluded.data, []);
  });

  test('combines filters (tag:, notebook:, -notebook:, type:, iscompleted:) with OCR queries', async () => {
    assert.deepEqual((await api('/api/search?q=tag%3Afinance-ocr%20Titanium')).data.map((n: any) => n.id), [noteMarkdownMulti]);
    assert.deepEqual(
      (await api('/api/search?q=notebook%3Awork%20Titanium')).data.map((n: any) => n.id).sort(),
      [noteMarkdownMulti, noteMixedTitle, noteTodoOpen].sort()
    );
    assert.deepEqual(
      (await api('/api/search?q=notebook%3Awork%20-notebook%3Aprojects%20Wrench')).data.map((n: any) => n.id).sort(),
      [noteMixedTitle, noteTodoOpen].sort()
    );
    assert.deepEqual((await api('/api/search?q=type%3Atodo%20Wrench')).data.map((n: any) => n.id), [noteTodoOpen]);
    assert.deepEqual((await api('/api/search?q=iscompleted%3A0%20Wrench')).data.map((n: any) => n.id), [noteTodoOpen]);
    assert.deepEqual((await api('/api/search?q=iscompleted%3A1%20Wrench')).data, []);
  });

  test('ignores OCR text unless ocr_status is 2 and skips encrypted, trashed, and conflict notes', async () => {
    for (const token of [
      'UnsearchableStatusZero',
      'UnsearchableStatusOne',
      'UnsearchableStatusThree',
      'UnsearchableMissingStatus',
    ]) {
      const res = await api(`/api/search?q=${token}`);
      assert.deepEqual(res.data, [], `status check failed for ${token}`);
    }

    const foundIds = new Set((await api('/api/search?q=Titanium')).data.map((n: any) => n.id));
    assert.ok(!foundIds.has(noteEncrypted), 'encrypted notes excluded');
    assert.ok(!foundIds.has(noteTrashed), 'trashed notes excluded');
    assert.ok(!foundIds.has(noteConflict), 'conflict copies excluded');
  });
});

describe('getNoteAttachmentText', () => {
  test('returns concatenated OCR text in link order, ignoring duplicates, note links and non-done resources', async () => {
    const { noteCache } = cacheModule;
    const full = await noteCache.getNoteAttachmentText(session, noteMarkdownMulti);
    assert.equal(
      full,
      [
        'Merchant: Harborview\nHardware Co.\nItem: Titanium Wrench #42\nSubtotal: $89.50',
        'Payment Method: Sapphire Card\nAuthorization Code: AUTH-99182\nLocation: Lisbon Wharf',
      ].join('\n\n')
    );

    const nonDone = await noteCache.getNoteAttachmentText(session, noteNonDone);
    assert.equal(nonDone, '');
    assert.equal(await noteCache.getNoteAttachmentText(session, noteEncrypted), '');
    assert.equal(await noteCache.getNoteAttachmentText(session, 'f'.repeat(32)), '');
  });

  test('truncates cleanly to maxChars without leaving a trailing separator', async () => {
    const { noteCache } = cacheModule;
    const full = await noteCache.getNoteAttachmentText(session, noteMarkdownMulti);
    const firstEnd = full.indexOf('\n\n');

    // Stops cleanly when maxChars falls inside the '\n\n' boundary
    const atBoundary = await noteCache.getNoteAttachmentText(session, noteMarkdownMulti, { maxChars: firstEnd + 1 });
    assert.equal(atBoundary, full.slice(0, firstEnd));

    // Includes the second attachment when room remains after '\n\n'
    const exactPlusTen = await noteCache.getNoteAttachmentText(session, noteMarkdownMulti, { maxChars: firstEnd + 12 });
    assert.equal(exactPlusTen, full.slice(0, firstEnd + 12));

    assert.equal(await noteCache.getNoteAttachmentText(session, noteMarkdownMulti, { maxChars: 0 }), '');
    assert.equal(await noteCache.getNoteAttachmentText(session, noteMarkdownMulti, { maxChars: -5 }), '');
    assert.equal(await noteCache.getNoteAttachmentText(session, noteMarkdownMulti, { maxChars: Number.NaN }), '');
    assert.equal(await noteCache.getNoteAttachmentText(session, noteMarkdownMulti, { maxChars: Infinity }), full);
  });
});

describe('delta refresh and v2 disk cache persistence', () => {
  test('delta refresh picks up resource OCR completion and updates, and v2 disk cache survives restart (v1 rebuilds)', async () => {
    const { noteCache, NoteCacheService } = cacheModule;

    // Before delta update, ocr_status is 1 so NotReadyBeforeDelta is absent
    assert.deepEqual((await api('/api/search?q=NotReadyBeforeDelta')).data, []);
    assert.deepEqual((await api('/api/search?q=DeltaOpticalTerm')).data, []);

    // Joplin Server receives completed OCR via delta feed
    putMockItem(app.mock, {
      ...((await import('./helpers.js')).mockItem(app.mock, resDelta)!),
      properties: {
        id: resDelta,
        mime: 'application/pdf',
        filename: 'delta_scan.pdf',
        size: '256',
        encryption_applied: '0',
        ocr_status: '2',
        ocr_text: 'DeltaOpticalTerm confirmed on page 1',
      },
    });
    app.mock.recordChange(`${resDelta}.md`, 2);
    await noteCache.refreshCache(session);

    const deltaSearch = await api('/api/search?q=DeltaOpticalTerm');
    assert.deepEqual(deltaSearch.data.map((n: any) => n.id), [noteDelta]);
    assert.equal(deltaSearch.data[0].matches.matchedIn, 'attachment');
    assert.equal(
      await noteCache.getNoteAttachmentText(session, noteDelta),
      'DeltaOpticalTerm confirmed on page 1'
    );

    // Simulate process restart with CACHE_DIR: v2 cache loads ocrText without reading items from server
    let itemReads = 0;
    let rootListings = 0;
    app.mock.onItemRequest = ({ name, suffix }) => {
      if (name === '' && suffix === '/children') rootListings++;
      else if (suffix === '/content') itemReads++;
    };
    const restarted = new NoteCacheService();
    const restartedHits = await restarted.searchNotes(session, 'DeltaOpticalTerm');
    assert.deepEqual(restartedHits.map((n) => n.id), [noteDelta]);
    assert.equal(await restarted.getNoteAttachmentText(session, noteDelta), 'DeltaOpticalTerm confirmed on page 1');
    assert.deepEqual([rootListings, itemReads], [0, 0], 'v2 disk cache served OCR without server requests');

    // Verify stale v1 cache on disk triggers a clean rebuild instead of losing ocrText
    const cacheFile = join(cacheDir, 'user-mockuser0000000000000000000000.json');
    const saved = JSON.parse(readFileSync(cacheFile, 'utf8'));
    assert.equal(saved.version, 2);
    const downgraded = {
      ...saved,
      version: 1,
      resources: saved.resources.map(([id, meta]: [string, Record<string, unknown>]) => {
        const { ocrText: _dropped, ...withoutOcr } = meta;
        return [id, withoutOcr];
      }),
    };
    writeFileSync(cacheFile, JSON.stringify(downgraded));

    const rebuiltService = new NoteCacheService();
    const rebuiltHits = await rebuiltService.searchNotes(session, 'DeltaOpticalTerm');
    assert.deepEqual(rebuiltHits.map((n) => n.id), [noteDelta]);
    assert.equal(rootListings, 1, 'v1 cache triggered a clean full rebuild');
    assert.ok(itemReads > 0);
    assert.equal(JSON.parse(readFileSync(cacheFile, 'utf8')).version, 2);

    // Deleting the resource via delta clears its OCR text
    app.mock.items.delete(`${resDelta}.md`);
    app.mock.recordChange(`${resDelta}.md`, 3);
    await noteCache.refreshCache(session);
    assert.deepEqual(await noteCache.searchNotes(session, 'DeltaOpticalTerm'), []);
    assert.equal(await noteCache.getNoteAttachmentText(session, noteDelta), '');
  });
});
