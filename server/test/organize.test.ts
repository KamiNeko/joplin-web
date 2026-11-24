import assert from 'node:assert/strict';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { demoId } from '../demo/seed.js';
import type { errorHandler as ErrorHandlerFn } from '../src/middleware/error-handler.js';
import type { createOrganizeRouter as CreateOrganizeRouterFn } from '../src/routes/organize.js';
import type { CacheEntry, noteCache as NoteCacheInstance } from '../src/services/note-cache.js';
import type {
  buildNoteSimilarityIndex as BuildNoteSimilarityIndexFn,
  buildOrganizeSystemPrompt as BuildOrganizeSystemPromptFn,
  buildOrganizeUserPrompt as BuildOrganizeUserPromptFn,
  isScannerStyleTitle as IsScannerStyleTitleFn,
  MAX_EXCLUDED_NOTEBOOKS as MaxExcludedNotebooksConst,
  MAX_ORGANIZE_NOTES as MaxOrganizeNotesConst,
  MAX_RETAINED_JOBS as MaxRetainedJobsConst,
  normalizeOrganizeTag as NormalizeOrganizeTagFn,
  ORGANIZE_DOCUMENT_TYPE_TAGS as OrganizeDocumentTypeTagsConst,
  OrganizerService as OrganizerServiceClass,
  organizerService as OrganizerServiceInstance,
  OrganizeValidationError as OrganizeValidationErrorClass,
  parseAndValidateSuggestion as ParseAndValidateSuggestionFn,
  recurringTagFilter as RecurringTagFilterFn,
  stripLinksFromBody as StripLinksFromBodyFn,
  LlmCompletionFn,
} from '../src/services/organizer.js';
import { serialize } from '../src/services/serializer.js';
import { JoplinItemType, type RawJoplinItem, type ResourceMetadata } from '../src/types/index.js';
import { mockItem, putMockItem, startTestApp, type TestApp } from './helpers.js';

const TEST_TIMEOUT_MS = 30_000;

let noteCache: typeof NoteCacheInstance;
let errorHandler: typeof ErrorHandlerFn;
let createOrganizeRouter: typeof CreateOrganizeRouterFn;
let buildNoteSimilarityIndex: typeof BuildNoteSimilarityIndexFn;
let buildOrganizeSystemPrompt: typeof BuildOrganizeSystemPromptFn;
let buildOrganizeUserPrompt: typeof BuildOrganizeUserPromptFn;
let isScannerStyleTitle: typeof IsScannerStyleTitleFn;
let MAX_EXCLUDED_NOTEBOOKS: typeof MaxExcludedNotebooksConst;
let MAX_ORGANIZE_NOTES: typeof MaxOrganizeNotesConst;
let MAX_RETAINED_JOBS: typeof MaxRetainedJobsConst;
let normalizeOrganizeTag: typeof NormalizeOrganizeTagFn;
let ORGANIZE_DOCUMENT_TYPE_TAGS: typeof OrganizeDocumentTypeTagsConst;
let OrganizerService: typeof OrganizerServiceClass;
let organizerService: typeof OrganizerServiceInstance;
let OrganizeValidationError: typeof OrganizeValidationErrorClass;
let parseAndValidateSuggestion: typeof ParseAndValidateSuggestionFn;
let recurringTagFilter: typeof RecurringTagFilterFn;
let stripLinksFromBody: typeof StripLinksFromBodyFn;

let tempCacheDir = '';
let app: TestApp;
let session = '';
const trackedServices = new Set<OrganizerServiceClass>();

function trackService<T extends OrganizerServiceClass>(svc: T): T {
  trackedServices.add(svc);
  return svc;
}

before(async () => {
  tempCacheDir = mkdtempSync(join(tmpdir(), 'joplin-organize-test-'));
  process.env.AI_BASE_URL = 'http://127.0.0.1:18317/v1';
  process.env.AI_MODEL = 'deepseek-flash';
  process.env.AI_API_KEY = 'sk-test-secret-do-not-log';
  process.env.AI_CONCURRENCY = '2';
  process.env.AI_FAKE = '1';

  app = await startTestApp({ cacheDir: tempCacheDir, pageSize: 50 });
  ({ noteCache } = await import('../src/services/note-cache.js'));
  ({ errorHandler } = await import('../src/middleware/error-handler.js'));
  ({ createOrganizeRouter } = await import('../src/routes/organize.js'));
  ({
    buildNoteSimilarityIndex,
    buildOrganizeSystemPrompt,
    buildOrganizeUserPrompt,
    isScannerStyleTitle,
    MAX_EXCLUDED_NOTEBOOKS,
    MAX_ORGANIZE_NOTES,
    MAX_RETAINED_JOBS,
    normalizeOrganizeTag,
    ORGANIZE_DOCUMENT_TYPE_TAGS,
    OrganizerService,
    organizerService,
    OrganizeValidationError,
    parseAndValidateSuggestion,
    recurringTagFilter,
    stripLinksFromBody,
  } = await import('../src/services/organizer.js'));
  session = await app.login();
});

afterEach(async () => {
  for (const svc of trackedServices) {
    await svc.shutdown();
  }
  trackedServices.clear();
});

after(async () => {
  for (const svc of trackedServices) {
    await svc.shutdown();
  }
  trackedServices.clear();
  if (organizerService) {
    await organizerService.shutdown();
  }
  await app.close();
  if (tempCacheDir) {
    rmSync(tempCacheDir, { recursive: true, force: true });
  }
});

async function pollUntilDone(jobId: string, apiFn = app.api): Promise<any> {
  for (let i = 0; i < 200; i++) {
    const res = await apiFn(`/api/organize/jobs/${jobId}?offset=0&limit=100`);
    assert.equal(res.status, 200);
    if (res.data.status !== 'running') return res.data;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Organize job did not finish in time');
}

describe('Auto-organize unit checks: prompts, similarity & validation', () => {
  test('builds deterministic byte-identical system prompt with fixed tag vocabulary, skips scanner titles, and excludes requested notebooks', { timeout: TEST_TIMEOUT_MS }, async () => {
    await app.api('/api/notebooks');
    const entry = await noteCache.ensureFresh(session, 'stale-ok');
    const excludeSet = new Set([demoId('nb-work')]);

    const first = buildOrganizeSystemPrompt(entry, excludeSet);
    const second = buildOrganizeSystemPrompt(entry, excludeSet);
    assert.equal(first.systemPrompt, second.systemPrompt);

    assert.ok(!first.allowedNotebookIds.includes(demoId('nb-work')));
    assert.ok(first.allowedNotebookIds.includes(demoId('nb-projects')));
    assert.match(first.systemPrompt, /Excluded target notebooks/);
    assert.match(first.systemPrompt, new RegExp(demoId('nb-work')));
    assert.match(first.systemPrompt, /Existing tags:/);
    assert.match(first.systemPrompt, /important/);
    for (const typeTag of ORGANIZE_DOCUMENT_TYPE_TAGS) {
      assert.ok(first.systemPrompt.includes(typeTag), `system prompt includes vocabulary tag ${typeTag}`);
    }
    // Descriptive note title in Projects appears in examples; scanner filename in Work/elsewhere does not
    assert.match(first.systemPrompt, /Website Relaunch Roadmap/);
    assert.doesNotMatch(first.systemPrompt, /2024_03_11\.pdf/);

    assert.equal(isScannerStyleTitle('2024_03_11.pdf'), true);
    assert.equal(isScannerStyleTitle('2024_03_11_14_22_05.pdf'), true);
    assert.equal(isScannerStyleTitle('IMG_20240101_120001'), true);
    assert.equal(isScannerStyleTitle('Website Relaunch Roadmap'), false);
  });

  test('strips links, caps body/OCR text, and renders exact similar-notes hint section in user prompt', { timeout: TEST_TIMEOUT_MS }, async () => {
    const body = `See [Invoice Portal](https://billing.example.com/pay) and ![scan](:/${'a'.repeat(32)}) for ${'x'.repeat(2500)}`;
    const stripped = stripLinksFromBody(body, 1, 2000);
    assert.ok(stripped.length <= 2000);
    assert.ok(!stripped.includes('https://billing.example.com'));
    assert.ok(!stripped.includes(`:/${'a'.repeat(32)}`));
    assert.ok(stripped.includes('Invoice Portal'));

    const longTitle = `2024-02-01 ${'HSBC UK Bank Statement '.repeat(5)}End`;
    const userPrompt = buildOrganizeUserPrompt({
      currentTitle: '2024_03_11.pdf',
      currentNotebookId: demoId('nb-work'),
      currentNotebookPath: 'Work',
      createdDate: '2024-03-11',
      bodyText: stripped,
      attachmentFilenames: ['2024_03_11.pdf'],
      ocrText: 'ACME CLOUD SERVICES INC. Total Paid: $420.00',
      similarNotes: [
        {
          noteId: demoId('sim-1'),
          notebookId: demoId('nb-projects'),
          notebookPath: 'Finance / Banking',
          title: longTitle,
          similarity: 0.834,
        },
        {
          noteId: demoId('sim-2'),
          notebookId: demoId('nb-personal'),
          notebookPath: 'Personal',
          title: 'Older Related Receipt',
          similarity: 0.42,
        },
        {
          noteId: demoId('sim-ignored'),
          notebookId: demoId('nb-personal'),
          notebookPath: 'Personal',
          title: 'Too Weak Match',
          similarity: 0.05,
        },
      ],
    });
    assert.match(userPrompt, /Current title: 2024_03_11\.pdf/);
    assert.match(userPrompt, /Current notebook: Work \(id: /);
    assert.match(userPrompt, /Attachment filenames:\n2024_03_11\.pdf/);
    assert.match(userPrompt, /ACME CLOUD SERVICES INC/);
    const expectedHeader =
      'Similar notes already filed by the user (by attachment text; usually the same issuer belongs in the same notebook):';
    const expectedLine1 = `- Finance / Banking (id: ${demoId('nb-projects')}) | "${longTitle.slice(0, 79)}…" | similarity 0.83`;
    const expectedLine2 = `- Personal (id: ${demoId('nb-personal')}) | "Older Related Receipt" | similarity 0.42`;
    assert.ok(userPrompt.endsWith(`${expectedHeader}\n${expectedLine1}\n${expectedLine2}`));
    assert.ok(!userPrompt.includes('Too Weak Match'));

    // Hint section is omitted when there is no OCR text or no neighbours above threshold
    const noOcrPrompt = buildOrganizeUserPrompt({
      currentTitle: 'Note without OCR',
      currentNotebookId: demoId('nb-work'),
      currentNotebookPath: 'Work',
      createdDate: '2024-03-11',
      bodyText: 'Plain markdown body.',
      attachmentFilenames: [],
      ocrText: '',
      similarNotes: [
        {
          noteId: demoId('sim-1'),
          notebookId: demoId('nb-projects'),
          notebookPath: 'Finance / Banking',
          title: 'Should Be Omitted',
          similarity: 0.9,
        },
      ],
    });
    assert.ok(!noOcrPrompt.includes('Similar notes already filed by the user'));
  });

  test('shows issuer tags only once they recur in the job; type and existing tags always', { timeout: TEST_TIMEOUT_MS }, () => {
    const job = [
      { suggestion: { tags: ['statement', 'hsbc'] } },
      { suggestion: { tags: ['statement', 'hsbc'] } },
      { suggestion: { tags: ['letter', 'hsbc'] } },
      { suggestion: { tags: ['letter', 'kindertons'] } },
      { suggestion: { tags: ['receipt', 'important'] } },
      {},
    ];
    const keep = recurringTagFilter(job, new Set(['important']));
    assert.equal(keep('hsbc'), true); // 3 notes
    assert.equal(keep('kindertons'), false); // one-off issuer
    assert.equal(keep('letter'), true); // document type
    assert.equal(keep('important'), true); // already in the account
    assert.equal(recurringTagFilter(job, new Set(), 4)('hsbc'), false);
  });

  test('validates JSON schema, strips extensions, enforces allowed notebooks, tag vocabulary & confidence fallback', { timeout: TEST_TIMEOUT_MS }, () => {
    const allowed = new Set([demoId('nb-projects'), demoId('nb-personal')]);
    assert.equal(ORGANIZE_DOCUMENT_TYPE_TAGS.length, 20);
    assert.equal(normalizeOrganizeTag(' John Lewis / UK '), 'john-lewis-uk');
    assert.equal(normalizeOrganizeTag('##Hang__Seng'), 'hang-seng');

    // Valid JSON wrapped in markdown fence + .pdf suffix + 1 vocab type tag + 1 issuer/other tag (drops extras)
    const good = parseAndValidateSuggestion(
      '```json\n' +
        JSON.stringify({
          title: '2024-03-11 Acme – Invoice.pdf',
          notebookId: demoId('nb-projects'),
          tags: ['Finance', 'invoice', 'FINANCE', 'cloud', 'extra'],
          confidence: 0.914,
          documentDate: '2024-03-11',
          reason: 'Matched invoice header from OCR.',
        }) +
        '\n```',
      {
        currentTitle: '2024_03_11.pdf',
        currentNotebookId: demoId('nb-work'),
        allowedNotebookIds: allowed,
      }
    );
    assert.equal(good.ok, true);
    if (good.ok) {
      assert.equal(good.suggestion.title, '2024-03-11 Acme – Invoice');
      assert.equal(good.suggestion.notebookId, demoId('nb-projects'));
      assert.deepEqual(good.suggestion.tags, ['invoice', 'finance']);
      assert.equal(good.suggestion.confidence, 0.91);
      assert.equal(good.suggestion.documentDate, '2024-03-11');
    }

    // Keeps at most one vocabulary document type + one lowercase-hyphenated issuer tag, drops excess types & issuers
    const vocabCheck = parseAndValidateSuggestion(
      JSON.stringify({
        title: '2024-05-01 John Lewis – Invoice',
        notebookId: demoId('nb-projects'),
        tags: ['INVOICE', 'receipt', 'John Lewis', 'retail', 'warranty'],
        confidence: 0.89,
        documentDate: '2024-05-01',
        reason: 'Matched invoice.',
      }),
      {
        currentTitle: 'scan.pdf',
        currentNotebookId: demoId('nb-work'),
        allowedNotebookIds: allowed,
      }
    );
    assert.equal(vocabCheck.ok, true);
    if (vocabCheck.ok) {
      assert.deepEqual(vocabCheck.suggestion.tags, ['invoice', 'john-lewis']);
    }

    // Handles reversed order (issuer first, vocabulary type second) and normalizes hyphenated vocab tag
    const idCheck = parseAndValidateSuggestion(
      JSON.stringify({
        title: '2024-06-01 HSBC – ID Document',
        notebookId: demoId('nb-personal'),
        tags: ['Hang Seng', 'ID Document', 'other', 'extra-issuer'],
        confidence: 0.9,
        documentDate: '2024-06-01',
        reason: 'ID check.',
      }),
      {
        currentTitle: 'scan2.pdf',
        currentNotebookId: demoId('nb-work'),
        allowedNotebookIds: allowed,
      }
    );
    assert.equal(idCheck.ok, true);
    if (idCheck.ok) {
      assert.deepEqual(idCheck.suggestion.tags, ['id-document', 'hang-seng']);
    }

    // Only one non-vocab tag kept when no vocab type matches
    const noTypeCheck = parseAndValidateSuggestion(
      JSON.stringify({
        title: '2024-06-01 HSBC – Note',
        notebookId: demoId('nb-personal'),
        tags: ['HSBC Bank', 'barclays'],
        confidence: 0.75,
        documentDate: '2024-06-01',
        reason: 'Bank note.',
      }),
      {
        currentTitle: 'scan3.pdf',
        currentNotebookId: demoId('nb-work'),
        allowedNotebookIds: allowed,
      }
    );
    assert.equal(noTypeCheck.ok, true);
    if (noTypeCheck.ok) {
      assert.deepEqual(noTypeCheck.suggestion.tags, ['hsbc-bank']);
    }

    // Unknown/excluded notebookId falls back to currentNotebookId and forces confidence = 0
    const badNb = parseAndValidateSuggestion(
      JSON.stringify({
        title: '2024-03-11 Acme – Invoice',
        notebookId: demoId('nb-work'), // excluded!
        tags: ['invoice'],
        confidence: 0.95,
        documentDate: '2024-03-11',
        reason: 'Suggested excluded notebook.',
      }),
      {
        currentTitle: '2024_03_11.pdf',
        currentNotebookId: demoId('nb-work'),
        allowedNotebookIds: allowed,
      }
    );
    assert.equal(badNb.ok, true);
    if (badNb.ok) {
      assert.equal(badNb.suggestion.notebookId, demoId('nb-work'));
      assert.equal(badNb.suggestion.confidence, 0);
    }

    // Invalid types rejected
    const badJson = parseAndValidateSuggestion('{not json', {
      currentTitle: 'a',
      currentNotebookId: demoId('nb-work'),
      allowedNotebookIds: allowed,
    });
    assert.equal(badJson.ok, false);

    const badDate = parseAndValidateSuggestion(
      JSON.stringify({
        title: 'Test',
        notebookId: demoId('nb-projects'),
        tags: [],
        confidence: 0.8,
        documentDate: '2024-02-31',
        reason: 'Invalid calendar date.',
      }),
      {
        currentTitle: 'Test',
        currentNotebookId: demoId('nb-work'),
        allowedNotebookIds: allowed,
      }
    );
    assert.equal(badDate.ok, false);
  });

  test('similarity index ranks same-issuer note first and excludes job notes, excluded notebooks, trashed/encrypted/conflict notes and short/missing OCR', { timeout: TEST_TIMEOUT_MS }, () => {
    const nbFinance = demoId('idx-nb-finance');
    const nbBanking = demoId('idx-nb-banking');
    const nbUtilities = demoId('idx-nb-utilities');
    const nbInbox = demoId('idx-nb-inbox');
    const nbTrashed = demoId('idx-nb-trashed');
    const nbEncrypted = demoId('idx-nb-encrypted');

    const makeFolder = (
      id: string,
      title: string,
      parentId = '',
      deletedTime = 0,
      properties: Record<string, string> = {}
    ): RawJoplinItem => ({
      id,
      type_: JoplinItemType.Folder,
      title,
      body: '',
      parentId,
      createdTime: 1,
      updatedTime: 1,
      userCreatedTime: 1,
      userUpdatedTime: 1,
      deletedTime,
      isTodo: false,
      todoDue: 0,
      todoCompleted: 0,
      properties,
    });

    const notebooks = new Map<string, RawJoplinItem>([
      [nbFinance, makeFolder(nbFinance, 'Finance')],
      [nbBanking, makeFolder(nbBanking, 'Banking', nbFinance)],
      [nbUtilities, makeFolder(nbUtilities, 'Utilities')],
      [nbInbox, makeFolder(nbInbox, 'Inbox')],
      [nbTrashed, makeFolder(nbTrashed, 'Old', '', 1000)],
      [nbEncrypted, makeFolder(nbEncrypted, '', '', 0, { encryption_applied: '1' })],
    ]);

    const notes = new Map<string, RawJoplinItem>();
    const resources = new Map<string, ResourceMetadata>();
    const addFiledNote = (
      key: string,
      opts: {
        parentId: string;
        title: string;
        ocrText: string | null;
        deletedTime?: number;
        props?: Record<string, string>;
      }
    ) => {
      const noteId = demoId(`idx-note-${key}`);
      const resId = demoId(`idx-res-${key}`);
      notes.set(noteId, {
        id: noteId,
        type_: JoplinItemType.Note,
        title: opts.title,
        body: opts.ocrText === null ? 'No attachment link here.' : `Scan ![doc](:/${resId})`,
        parentId: opts.parentId,
        createdTime: 1000,
        updatedTime: 1000,
        userCreatedTime: 1000,
        userUpdatedTime: 1000,
        deletedTime: opts.deletedTime ?? 0,
        isTodo: false,
        todoDue: 0,
        todoCompleted: 0,
        properties: opts.props ?? {},
      });
      if (opts.ocrText !== null) {
        resources.set(resId, {
          id: resId,
          title: `${key}.pdf`,
          mime: 'application/pdf',
          filename: `${key}.pdf`,
          fileExtension: 'pdf',
          size: 100,
          updatedTime: 1000,
          ocrText: opts.ocrText,
        });
      }
      return noteId;
    };

    const hsbcPrimary = addFiledNote('hsbc-primary', {
      parentId: nbBanking,
      title: '2025-01-15 HSBC UK – Current Account Statement 400011',
      ocrText:
        'HSBC Bank UK plc monthly current account statement sorting code 400011 account number 12345678 closing balance GBP 2450.00 direct debit summary london',
    });
    const hsbcSecondary = addFiledNote('hsbc-secondary', {
      parentId: nbBanking,
      title: '2025-02-01 HSBC UK – Savings Statement',
      ocrText:
        'HSBC Bank UK plc quarterly savings statement opening balance GBP 9000.00 sorting code 400011 interest earned bonus saver branch address birmingham summary',
    });
    const utilityOne = addFiledNote('utility-1', {
      parentId: nbUtilities,
      title: '2025-01-20 Thames Water – Quarterly Bill',
      ocrText:
        'Thames Water Utilities Limited wastewater sewerage supply bill account reference 99118877 meter reading usage period summary statement of charges london',
    });
    const utilityTwo = addFiledNote('utility-2', {
      parentId: nbUtilities,
      title: '2025-02-20 Thames Water – Metered Bill',
      ocrText:
        'Thames Water Utilities Limited annual supply charges meter reading 44556677 direct debit plan statement summary customer helpline reading berkshire water services uk',
    });
    const cjkOne = addFiledNote('cjk-1', {
      parentId: nbFinance,
      title: '2025-01-30 中銀香港 – 月結單',
      ocrText:
        '中國銀行香港有限公司 綜合戶口月結單 客戶編號 98765432 結餘港元 180000 交易紀錄摘要 每月通知書 香港中環花園道一號 銀行服務熱線 定期存款結算詳情 戶口轉賬紀錄及電子通知書服務條款 敬請查閱附件明細資料並妥善保存以作日後核對用途 本月結單已全面核實無誤 如對上述交易內容有任何疑問 請於三十天內聯絡本行客戶服務代表查詢跟進',
    });
    const cjkTwo = addFiledNote('cjk-2', {
      parentId: nbFinance,
      title: '2025-02-28 中銀香港 – 儲蓄月結單',
      ocrText:
        '中國銀行香港有限公司 儲蓄存款月結單 客戶編號 98765432 利息結算 250000 結餘查詢摘要 每月通知書 香港九龍旺角分行 銀行客戶服務熱線 存款利息計算詳情 自動轉賬紀錄及電子結單服務條款 敬請核對本期收支明細並保留備查 銀行客戶服務中心敬上 如對本期月結單任何項目有所疑問 請致電本行熱線電話查詢詳情',
    });

    // Notes that must be excluded from the index:
    const jobOwnId = addFiledNote('job-own', {
      parentId: nbBanking,
      title: '2025-03-01 HSBC UK – Job Target Note',
      ocrText:
        'HSBC Bank UK plc monthly current account statement sorting code 400011 account number 12345678 exact duplicate text that must not self-match inside the same job',
    });
    const excludedNbNote = addFiledNote('excluded-nb', {
      parentId: nbInbox,
      title: 'HSBC Inbox Note',
      ocrText:
        'HSBC Bank UK plc monthly current account statement sorting code 400011 inbox copy that belongs to an excluded notebook and must not influence suggestions',
    });
    const trashedNote = addFiledNote('trashed', {
      parentId: nbBanking,
      title: 'Trashed HSBC Note',
      deletedTime: 2000,
      ocrText:
        'HSBC Bank UK plc monthly current account statement sorting code 400011 deleted note sitting in trash waiting to be purged forever',
    });
    const trashedNbNote = addFiledNote('trashed-nb', {
      parentId: nbTrashed,
      title: 'Note in Trashed Notebook',
      ocrText:
        'HSBC Bank UK plc monthly current account statement sorting code 400011 sitting inside a trashed notebook and therefore excluded',
    });
    const conflictNote = addFiledNote('conflict', {
      parentId: nbBanking,
      title: 'Conflict HSBC Note',
      props: { is_conflict: '1' },
      ocrText:
        'HSBC Bank UK plc monthly current account statement sorting code 400011 conflict copy produced by Joplin sync and excluded from search/index',
    });
    const encryptedNote = addFiledNote('encrypted-note', {
      parentId: nbBanking,
      title: '',
      props: { encryption_applied: '1' },
      ocrText:
        'HSBC Bank UK plc monthly current account statement sorting code 400011 ciphered note text that must never enter similarity index',
    });
    const encryptedNbNote = addFiledNote('encrypted-nb', {
      parentId: nbEncrypted,
      title: 'Encrypted Notebook Note',
      ocrText:
        'HSBC Bank UK plc monthly current account statement sorting code 400011 inside encrypted notebook must not enter similarity index',
    });
    const shortOcrNote = addFiledNote('short-ocr', {
      parentId: nbBanking,
      title: 'Short OCR HSBC Note',
      ocrText: 'HSBC 400011 short text under 150 chars',
    });
    addFiledNote('no-ocr', {
      parentId: nbBanking,
      title: 'No OCR Note',
      ocrText: null,
    });

    const entry: CacheEntry = {
      lastFetched: Date.now(),
      lastAccessed: Date.now(),
      fetchPromise: null,
      lastRefreshFailed: false,
      notebooks,
      notes,
      tags: new Map(),
      noteTags: [],
      resources,
      itemTimestamps: new Map(),
      syncInfoUpdatedTime: null,
      deltaCursor: null,
      encryptedItemIds: new Set([encryptedNote, nbEncrypted]),
      masterKeyIds: new Set(),
      unreadableItems: new Set(),
      localChanges: new Map(),
    };

    const index = buildNoteSimilarityIndex(entry, {
      excludeNotebookIds: new Set([nbInbox]),
      excludeNoteIds: new Set([jobOwnId]),
    });

    assert.equal(index.size, 6);

    const hits = index.findSimilar(
      'HSBC Bank UK plc current account statement sorting code 400011 balance summary direct debit',
      5
    );
    assert.ok(hits.length >= 2);
    assert.equal(hits[0].noteId, hsbcPrimary);
    assert.equal(hits[0].notebookId, nbBanking);
    assert.equal(hits[0].notebookPath, 'Finance / Banking');
    assert.equal(hits[1].noteId, hsbcSecondary);
    assert.ok(hits[0].similarity > hits[1].similarity);

    const hitIds = new Set(hits.map((h) => h.noteId));
    for (const forbidden of [
      jobOwnId,
      excludedNbNote,
      trashedNote,
      trashedNbNote,
      conflictNote,
      encryptedNote,
      encryptedNbNote,
      shortOcrNote,
    ]) {
      assert.ok(!hitIds.has(forbidden), `expected note ${forbidden} to be excluded`);
    }
    if (hits.length > 2) {
      assert.ok(hits[1].similarity > hits[2].similarity);
    }
    assert.ok(!hitIds.has(cjkOne) && !hitIds.has(cjkTwo));

    // CJK bigrams and 4+ digit numbers match too
    const cjkHits = index.findSimilar('中國銀行香港 戶口月結單 客戶編號 98765432', 5);
    assert.equal(cjkHits.length, 2);
    assert.deepEqual(new Set(cjkHits.map((h) => h.noteId)), new Set([cjkOne, cjkTwo]));
  });
});

describe('OrganizerService: OpenAI HTTP client, retries, repairs, persistence and resume', () => {
  test('calls OpenAI-compatible Chat Completions with json_object format, retries 429/500 with backoff, never logs content or key', { timeout: TEST_TIMEOUT_MS }, async () => {
    const requests: Array<{ auth?: string; body: any }> = [];
    let attempt = 0;

    const llmServer: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        requests.push({ auth: req.headers.authorization, body });
        attempt++;
        if (attempt === 1) {
          res.writeHead(429, { 'Retry-After': '0' });
          res.end('rate limited');
          return;
        }
        if (attempt === 2) {
          res.writeHead(503);
          res.end('temporary error');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    title: '2024-03-11 Acme Cloud – Invoice',
                    notebookId: demoId('nb-projects'),
                    tags: ['important', 'invoice'],
                    confidence: 0.92,
                    documentDate: '2024-03-11',
                    reason: 'OCR shows Acme invoice.',
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
          })
        );
      });
    });

    await new Promise<void>((resolve) => llmServer.listen(0, '127.0.0.1', resolve));
    const llmPort = (llmServer.address() as AddressInfo).port;
    const logs: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    const origWarn = console.warn;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    console.error = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    console.warn = (...args: unknown[]) => logs.push(args.map(String).join(' '));

    try {
      const svc = trackService(
        new OrganizerService({
          aiBaseUrl: `http://127.0.0.1:${llmPort}/v1`,
          aiApiKey: 'sk-super-secret-value',
          aiModel: 'deepseek-flash',
          aiConcurrency: 1,
          aiFake: false,
          cacheDir: null,
          sleep: async () => {},
          retryBaseDelayMs: 0,
        })
      );

      const { jobId } = await svc.startJob(session, {
        noteIds: [demoId('note-scanned-invoice'), demoId('note-markdown-extras')],
        excludeNotebookIds: [demoId('nb-work')],
      });
      await svc.waitForIdle(session);
      const job = await svc.getJob(session, jobId);

      assert.equal(job.status, 'done');
      assert.equal(job.progress.done, 2);
      assert.equal(job.progress.failed, 0);
      assert.equal(job.usage.totalTokens, 280);
      assert.equal(requests.length, 4); // 1st note: 429, 503, 200; 2nd note: 200
      assert.equal(requests[0].auth, 'Bearer sk-super-secret-value');
      assert.deepEqual(requests[0].body.response_format, { type: 'json_object' });
      // Prompt caching requirement: system message is byte-identical across the entire job
      assert.equal(requests[0].body.messages[0].content, requests[3].body.messages[0].content);

      const joinedLogs = logs.join('\n');
      assert.ok(!joinedLogs.includes('sk-super-secret-value'), 'API key is never logged');
      assert.ok(!joinedLogs.includes('Dedicated Backup Storage'), 'Note/OCR content is never logged');
    } finally {
      console.log = origLog;
      console.error = origError;
      console.warn = origWarn;
      llmServer.closeAllConnections?.();
      await new Promise((resolve) => llmServer.close(resolve));
    }
  });

  test('injects similar-notes hint into user prompt only, preserves byte-identical system prompt, and drops index on finish/cancel', { timeout: TEST_TIMEOUT_MS }, async () => {
    const addedKeys: string[] = [];
    const now = Date.now();
    const putDoc = (key: string, notebookId: string, title: string, ocrText: string) => {
      const noteId = demoId(`svc-hint-note-${key}`);
      const resId = demoId(`svc-hint-res-${key}`);
      putMockItem(
        app.mock,
        {
          type_: JoplinItemType.Resource,
          id: resId,
          title: `${key}.pdf`,
          properties: {
            id: resId,
            mime: 'application/pdf',
            filename: `${key}.pdf`,
            file_extension: 'pdf',
            size: '128',
            encryption_applied: '0',
            ocr_status: '2',
            ocr_text: ocrText,
            updated_time: new Date(now).toISOString(),
            deleted_time: '0',
          },
        },
        now
      );
      putMockItem(
        app.mock,
        {
          type_: JoplinItemType.Note,
          id: noteId,
          title,
          body: `Attachment ![doc](:/${resId})`,
          properties: {
            id: noteId,
            parent_id: notebookId,
            updated_time: new Date(now).toISOString(),
            deleted_time: '0',
            encryption_applied: '0',
          },
        },
        now
      );
      addedKeys.push(`${resId}.md`, `${noteId}.md`);
      return noteId;
    };

    try {
      const filedHsbc1 = putDoc(
        'hsbc-filed-1',
        demoId('nb-personal'),
        '2025-01-10 HSBC – Current Account Statement',
        'HSBC UK Bank plc monthly current account statement sorting code 400011 balance GBP 3100.00 customer notice direct debit reference 551100 standing order summary london branch uk'
      );
      putDoc(
        'hsbc-filed-2',
        demoId('nb-personal'),
        '2025-02-10 HSBC – Savings Account Statement',
        'HSBC UK Bank plc quarterly savings statement sorting code 400011 interest summary GBP 9200.00 bonus saver account branch birmingham customer helpline uk banking'
      );
      putDoc(
        'water-filed-1',
        demoId('nb-reading'),
        '2025-01-15 Thames Water – Bill',
        'Thames Water Utilities Limited sewerage supply charges meter reading 88776655 statement period summary direct debit customer helpline berkshire united kingdom'
      );
      const targetNoteId = putDoc(
        'hsbc-target',
        demoId('nb-work'),
        '2025_03_10.pdf',
        'HSBC UK Bank plc monthly current account statement sorting code 400011 balance GBP 3450.00 direct debit reference 551100 standing order summary london branch uk'
      );

      await app.api('/api/notebooks/refresh', { method: 'POST' });

      const capturedPrompts: Array<{ system: string; user: string }> = [];
      let releaseFirst!: () => void;
      const firstEntered = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let allowFinish!: () => void;
      const finishGate = new Promise<void>((resolve) => {
        allowFinish = resolve;
      });

      let callIdx = 0;
      const svc = trackService(
        new OrganizerService({
          aiBaseUrl: 'http://127.0.0.1:18317/v1',
          aiModel: 'deepseek-flash',
          aiConcurrency: 1,
          aiFake: false,
          cacheDir: null,
          completionFn: async (messages, signal) => {
            capturedPrompts.push({
              system: messages[0]?.content ?? '',
              user: messages[1]?.content ?? '',
            });
            callIdx++;
            if (callIdx === 1) {
              releaseFirst();
              await new Promise<void>((resolve, reject) => {
                if (signal.aborted) {
                  reject(new DOMException('Aborted', 'AbortError'));
                  return;
                }
                const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
                signal.addEventListener('abort', onAbort, { once: true });
                void finishGate.then(() => {
                  signal.removeEventListener('abort', onAbort);
                  resolve();
                });
              });
            }
            return {
              content: JSON.stringify({
                title: '2025-03-10 HSBC – Current Account Statement',
                notebookId: demoId('nb-personal'),
                tags: ['statement', 'hsbc'],
                confidence: 0.94,
                documentDate: '2025-03-10',
                reason: 'Matched HSBC OCR and similar filed statements.',
              }),
              usage: { promptTokens: 80, completionTokens: 25, totalTokens: 105 },
            };
          },
        })
      );

      const { jobId } = await svc.startJob(session, {
        noteIds: [targetNoteId, demoId('note-markdown-extras')],
        excludeNotebookIds: [demoId('nb-work')],
      });
      await firstEntered;
      assert.equal(svc.hasSimilarityIndex(session), true);

      allowFinish();
      await svc.waitForIdle(session);
      assert.equal(svc.hasSimilarityIndex(session), false);

      const job = await svc.getJob(session, jobId);
      assert.equal(job.status, 'done');
      assert.equal(capturedPrompts.length, 2);
      // System prompt stays byte-identical across the entire job and holds no per-note hint section
      assert.equal(capturedPrompts[0].system, capturedPrompts[1].system);
      assert.ok(!capturedPrompts[0].system.includes('Similar notes already filed by the user'));

      // Target OCR note receives exact similar-notes hint section (best match first, never target itself)
      assert.match(
        capturedPrompts[0].user,
        new RegExp(
          `Similar notes already filed by the user \\(by attachment text; usually the same issuer belongs in the same notebook\\):\\n- Personal \\(id: ${demoId('nb-personal')}\\) \\| "2025-01-10 HSBC – Current Account Statement" \\| similarity [01]\\.\\d{2}`
        )
      );
      assert.ok(!capturedPrompts[0].user.includes('2025_03_10.pdf" | similarity'));
      assert.ok(filedHsbc1);

      // Non-OCR note omits the similar-notes hint section completely
      assert.ok(!capturedPrompts[1].user.includes('Similar notes already filed by the user'));

      // Cancel also drops the in-memory similarity index immediately
      let releaseCancelStart!: () => void;
      const cancelStarted = new Promise<void>((resolve) => {
        releaseCancelStart = resolve;
      });
      const cancelSvc = trackService(
        new OrganizerService({
          aiBaseUrl: 'http://127.0.0.1:18317/v1',
          aiModel: 'deepseek-flash',
          aiConcurrency: 1,
          aiFake: false,
          cacheDir: null,
          completionFn: async (_msgs, signal) => {
            releaseCancelStart();
            await new Promise<void>((_resolve, reject) => {
              if (signal.aborted) {
                reject(new DOMException('Aborted', 'AbortError'));
                return;
              }
              signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
            });
            throw new Error('unreachable');
          },
        })
      );
      const cancelledJob = await cancelSvc.startJob(session, { noteIds: [targetNoteId] });
      await cancelStarted;
      assert.equal(cancelSvc.hasSimilarityIndex(session), true);
      await cancelSvc.cancelJob(session, cancelledJob.jobId);
      assert.equal(cancelSvc.hasSimilarityIndex(session), false);
    } finally {
      for (const k of addedKeys) {
        app.mock.items.delete(k);
      }
      await app.api('/api/notebooks/refresh', { method: 'POST' });
    }
  });

  test('repairs invalid JSON once, then marks item failed if second response is still invalid', { timeout: TEST_TIMEOUT_MS }, async () => {
    let callsForFirst = 0;
    let callsForSecond = 0;
    const completionFn: LlmCompletionFn = async (messages) => {
      const userMsg = messages[1]?.content ?? '';
      const isSecond = userMsg.includes('Markdown Extras');
      if (!isSecond) {
        callsForFirst++;
        if (callsForFirst === 1) {
          return { content: 'not valid json', usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 } };
        }
        return {
          content: JSON.stringify({
            title: '2024-03-11 Repaired Title',
            notebookId: demoId('nb-projects'),
            tags: ['repaired'],
            confidence: 0.85,
            documentDate: '2024-03-11',
            reason: 'Fixed JSON on repair turn.',
          }),
          usage: { promptTokens: 70, completionTokens: 20, totalTokens: 90 },
        };
      }
      callsForSecond++;
      return { content: '{still broken', usage: { promptTokens: 40, completionTokens: 5, totalTokens: 45 } };
    };

    const svc = trackService(
      new OrganizerService({
        aiBaseUrl: 'http://127.0.0.1:18317/v1',
        aiModel: 'deepseek-flash',
        aiConcurrency: 1,
        cacheDir: null,
        completionFn,
      })
    );

    const { jobId } = await svc.startJob(session, {
      noteIds: [demoId('note-scanned-invoice'), demoId('note-markdown-extras')],
      excludeNotebookIds: [demoId('nb-work')],
    });
    await svc.waitForIdle(session);
    const job = await svc.getJob(session, jobId);

    assert.equal(callsForFirst, 2);
    assert.equal(callsForSecond, 2);
    assert.equal(job.status, 'done');
    assert.equal(job.progress.done, 1);
    assert.equal(job.progress.failed, 1);
    assert.equal(job.items[0].status, 'done');
    assert.equal(job.items[0].suggestion?.title, '2024-03-11 Repaired Title');
    assert.equal(job.items[1].status, 'failed');
    assert.match(job.items[1].error ?? '', /invalid suggestion JSON/i);
    assert.equal(job.usage.totalTokens, 60 + 90 + 45 + 45);
  });

  test('persists job under CACHE_DIR and resumes unfinished items on startup and session attach', { timeout: TEST_TIMEOUT_MS }, async () => {
    const isolatedCacheDir = mkdtempSync(join(tmpdir(), 'joplin-organize-resume-'));
    try {
      // Ensure user note cache exists in tempCacheDir so resumeFromDiskOnStartup can read saved entry
      await noteCache.ensureFresh(session, 'force');
      const ownerKey = noteCache.getOwnerKey(session);
      assert.ok(ownerKey.startsWith('user-'));

      let releaseSecond!: () => void;
      const secondStarted = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });

      let callCount = 0;
      const interruptingClient: LlmCompletionFn = async (_msgs, signal) => {
        callCount++;
        if (callCount === 1) {
          return {
            content: JSON.stringify({
              title: '2024-03-11 First Note',
              notebookId: demoId('nb-projects'),
              tags: ['first'],
              confidence: 0.9,
              documentDate: '2024-03-11',
              reason: 'First item completed.',
            }),
            usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
          };
        }
        releaseSecond();
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
        throw new Error('unreachable');
      };

      const svc1 = trackService(
        new OrganizerService({
          aiBaseUrl: 'http://127.0.0.1:18317/v1',
          aiModel: 'deepseek-flash',
          aiConcurrency: 1,
          aiFake: false,
          cacheDir: tempCacheDir, // shares noteCache's ownerKey and saved cache file
          completionFn: interruptingClient,
        })
      );

      const { jobId } = await svc1.startJob(session, {
        noteIds: [demoId('note-scanned-invoice'), demoId('note-markdown-extras')],
        excludeNotebookIds: [demoId('nb-work')],
      });
      await secondStarted;
      await svc1.shutdown();
      assert.equal(svc1.hasSimilarityIndex(session), false);

      // Confirm persisted v2 files show job still running with item 0 done and item 1 pending (and no similarity index on disk)
      const persistedIndexPath = join(tempCacheDir, 'organize', ownerKey, 'index.json');
      const persistedJobPath = join(tempCacheDir, 'organize', ownerKey, `${jobId}.json`);
      const persistedIndex = JSON.parse(readFileSync(persistedIndexPath, 'utf8'));
      const persistedRaw = readFileSync(persistedJobPath, 'utf8');
      const persisted = JSON.parse(persistedRaw);
      assert.equal(persistedIndex.version, 2);
      assert.equal(persistedIndex.jobs[0].id, jobId);
      assert.equal(persisted.version, 2);
      assert.equal(persisted.job.id, jobId);
      assert.equal(persisted.job.status, 'running');
      assert.equal(persisted.job.items[0].status, 'done');
      assert.equal(persisted.job.items[1].status, 'pending');
      assert.ok(!persistedRaw.includes('similarityIndex'));

      // New service instance simulates server restart -> resumeFromDiskOnStartup finishes remaining work
      const svc2 = trackService(
        new OrganizerService({
          aiBaseUrl: 'http://127.0.0.1:18317/v1',
          aiModel: 'deepseek-flash',
          aiConcurrency: 2,
          aiFake: true,
          cacheDir: tempCacheDir,
        })
      );
      svc2.resumeFromDiskOnStartup();
      await svc2.waitForIdle(session);
      const resumed = await svc2.getJob(session, jobId);
      assert.equal(resumed.status, 'done');
      assert.equal(resumed.progress.done, 2);
      assert.equal(svc2.hasSimilarityIndex(session), false);

      // Isolate cross-session ownership with session-<sha256> when CACHE_DIR is omitted/custom session
      const svcSession = trackService(
        new OrganizerService({
          aiBaseUrl: 'http://127.0.0.1:18317/v1',
          aiModel: 'deepseek-flash',
          aiFake: true,
          cacheDir: isolatedCacheDir,
        })
      );
      const { jobId: ownedJobId } = await svcSession.startJob(session, {
        noteIds: [demoId('note-scanned-invoice')],
      });
      await svcSession.waitForIdle(session);
      await assert.rejects(() => svcSession.getJob('completely-different-session', ownedJobId), /not found/i);
    } finally {
      rmSync(isolatedCacheDir, { recursive: true, force: true });
    }
  });
});

describe('HTTP /api/organize endpoints: lifecycle, cancel, apply with conflict, and undo', () => {
  test('status returns enabled & model without leaking provider URL or key', { timeout: TEST_TIMEOUT_MS }, async () => {
    const res = await app.api('/api/organize/status');
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { enabled: true, model: 'deepseek-flash' });
  });

  test('starts a job, pages suggestions, avoids excluded notebook, and supports cancel', { timeout: TEST_TIMEOUT_MS }, async () => {
    const startRes = await app.api('/api/organize/jobs', {
      method: 'POST',
      body: JSON.stringify({
        noteIds: [
          demoId('note-scanned-invoice'),
          demoId('note-markdown-extras'),
          demoId('note-roadmap'),
        ],
        excludeNotebookIds: [demoId('nb-work')],
      }),
    });
    assert.equal(startRes.status, 201);
    assert.ok(startRes.data.jobId);

    const job = await pollUntilDone(startRes.data.jobId);
    assert.equal(job.status, 'done');
    assert.equal(job.progress.total, 3);
    assert.equal(job.progress.done, 3);
    assert.ok(job.usage.totalTokens > 0);
    assert.equal(job.items[0].noteId, demoId('note-scanned-invoice'));
    assert.equal(job.items[0].suggestion.title, '2024-03-11 Acme Cloud Services – Dedicated Backup Storage Invoice');
    assert.notEqual(job.items[0].suggestion.notebookId, demoId('nb-work'));
    assert.ok(job.items[0].suggestion.confidence >= 0.7);
    assert.equal(job.items[1].suggestion.title, 'Markdown Extras: Math, Diagrams & More');
    assert.ok(job.items[1].suggestion.confidence < 0.7);

    // Paging works cleanly
    const page2 = await app.api(`/api/organize/jobs/${startRes.data.jobId}?offset=1&limit=1`);
    assert.equal(page2.status, 200);
    assert.equal(page2.data.totalItems, 3);
    assert.equal(page2.data.items.length, 1);
    assert.equal(page2.data.items[0].noteId, demoId('note-markdown-extras'));

    // Encrypted & missing items are handled individually without failing the job
    const encId = demoId('org-encrypted-note');
    putMockItem(
      app.mock,
      {
        type_: JoplinItemType.Note,
        id: encId,
        properties: {
          id: encId,
          parent_id: demoId('nb-personal'),
          updated_time: new Date().toISOString(),
          deleted_time: '0',
          encryption_applied: '1',
          encryption_cipher_text: 'JED01000022abcd',
        },
      },
      Date.now()
    );
    try {
      const mixedRes = await app.api('/api/organize/jobs', {
        method: 'POST',
        body: JSON.stringify({ noteIds: [encId, demoId('note-ramen')] }),
      });
      assert.equal(mixedRes.status, 201);
      const mixedJob = await pollUntilDone(mixedRes.data.jobId);
      assert.equal(mixedJob.items[0].status, 'failed');
      assert.match(mixedJob.items[0].error, /Encrypted/);
      assert.equal(mixedJob.items[1].status, 'done');

      // Cancelling an already-done or running job returns 200; invalid IDs fail 400
      const cancelRes = await app.api(`/api/organize/jobs/${mixedRes.data.jobId}`, { method: 'DELETE' });
      assert.equal(cancelRes.status, 200);
      const badStart = await app.api('/api/organize/jobs', {
        method: 'POST',
        body: JSON.stringify({ noteIds: ['../bad'] }),
      });
      assert.equal(badStart.status, 400);
    } finally {
      app.mock.items.delete(`${encId}.md`);
      await app.api('/api/notebooks/refresh', { method: 'POST' });
    }
  });

  test('cancels an in-flight running job via DELETE /api/organize/jobs/:id', { timeout: TEST_TIMEOUT_MS }, async () => {
    const created = await app.api('/api/organize/jobs', {
      method: 'POST',
      body: JSON.stringify({
        noteIds: [
          demoId('note-roadmap'),
          demoId('note-api-notes'),
          demoId('note-weekly-sync'),
          demoId('note-lisbon'),
          demoId('note-ramen'),
        ],
      }),
    });
    assert.equal(created.status, 201);
    const delRes = await app.api(`/api/organize/jobs/${created.data.jobId}`, { method: 'DELETE' });
    assert.equal(delRes.status, 200);
    assert.ok(['cancelled', 'done'].includes(delRes.data.status));
  });

  test('applies suggestions with conflict isolation and reverts cleanly on undo (skipping changed notes)', { timeout: TEST_TIMEOUT_MS }, async () => {
    // Create two isolated test notes: noteA has pre-existing tag 'planning'
    const c1 = await app.api('/api/notes', {
      method: 'POST',
      body: JSON.stringify({
        parentId: demoId('nb-work'),
        title: '2024_04_01.pdf',
        body: 'Acme Cloud Services invoice dated 2024-04-01.',
      }),
    });
    assert.equal(c1.status, 201);
    const noteA = c1.data;
    await app.api(`/api/notes/${noteA.id}/tags`, {
      method: 'POST',
      body: JSON.stringify({ title: 'planning' }),
    });
    const noteAWithTag = (await app.api(`/api/notes/${noteA.id}`)).data;

    const c2 = await app.api('/api/notes', {
      method: 'POST',
      body: JSON.stringify({
        parentId: demoId('nb-work'),
        title: '2024_04_02.pdf',
        body: 'Electricity bill statement.',
      }),
    });
    assert.equal(c2.status, 201);
    const noteB = c2.data;

    const jobCreate = await app.api('/api/organize/jobs', {
      method: 'POST',
      body: JSON.stringify({
        noteIds: [noteA.id, noteB.id],
        excludeNotebookIds: [demoId('nb-work')],
      }),
    });
    assert.equal(jobCreate.status, 201);
    const job = await pollUntilDone(jobCreate.data.jobId);

    // Externally modify noteB before apply so noteB conflicts while noteA succeeds
    const rawB = mockItem(app.mock, noteB.id)!;
    const bumpedBTime = rawB.updatedTime + 5000;
    app.mock.items.set(`${noteB.id}.md`, {
      content: Buffer.from(
        serialize({
          type_: JoplinItemType.Note,
          title: 'Edited externally B',
          body: rawB.body,
          properties: { ...rawB.properties, updated_time: new Date(bumpedBTime).toISOString() },
        }),
        'utf8'
      ),
      contentType: 'text/plain; charset=utf-8',
      updatedTime: bumpedBTime,
    });

    const applyRes = await app.api(`/api/organize/jobs/${job.id}/apply`, {
      method: 'POST',
      body: JSON.stringify({
        items: [
          {
            noteId: noteA.id,
            title: '2024-04-01 Acme Cloud – Storage Invoice',
            notebookId: demoId('nb-projects'),
            addTags: ['planning', 'invoice'],
            baseUpdatedTime: noteAWithTag.updatedTime,
          },
          {
            noteId: noteB.id,
            title: '2024-04-02 Utility – Bill',
            notebookId: demoId('nb-personal'),
            addTags: ['bills'],
            baseUpdatedTime: noteB.updatedTime,
          },
        ],
      }),
    });
    assert.equal(applyRes.status, 200);
    assert.equal(applyRes.data.appliedCount, 1);
    assert.equal(applyRes.data.conflictCount, 1);
    assert.equal(applyRes.data.canUndo, true);

    const updatedA = (await app.api(`/api/notes/${noteA.id}`)).data;
    assert.equal(updatedA.title, '2024-04-01 Acme Cloud – Storage Invoice');
    assert.equal(updatedA.parentId, demoId('nb-projects'));
    assert.deepEqual(updatedA.tags.map((t: any) => t.title).sort(), ['invoice', 'planning']);

    const untouchedB = (await app.api(`/api/notes/${noteB.id}`)).data;
    assert.equal(untouchedB.title, 'Edited externally B');
    assert.equal(untouchedB.parentId, demoId('nb-work'));

    // Undo reverts noteA back to original title/notebook while preserving pre-existing 'planning'
    const undoRes = await app.api(`/api/organize/jobs/${job.id}/undo`, { method: 'POST' });
    assert.equal(undoRes.status, 200);
    assert.equal(undoRes.data.revertedCount, 1);
    assert.equal(undoRes.data.conflictCount, 0);
    assert.equal(undoRes.data.canUndo, false);

    const revertedA = (await app.api(`/api/notes/${noteA.id}`)).data;
    assert.equal(revertedA.title, '2024_04_01.pdf');
    assert.equal(revertedA.parentId, demoId('nb-work'));
    assert.deepEqual(revertedA.tags.map((t: any) => t.title), ['planning']);

    // Second apply + external change before undo -> undo skips changed note
    const apply2 = await app.api(`/api/organize/jobs/${job.id}/apply`, {
      method: 'POST',
      body: JSON.stringify({
        items: [
          {
            noteId: noteA.id,
            title: '2024-04-01 Reapplied A',
            notebookId: demoId('nb-projects'),
            baseUpdatedTime: revertedA.updatedTime,
          },
          {
            noteId: noteB.id,
            title: '2024-04-02 Applied B',
            notebookId: demoId('nb-personal'),
            baseUpdatedTime: untouchedB.updatedTime,
          },
        ],
      }),
    });
    assert.equal(apply2.status, 200);
    assert.equal(apply2.data.appliedCount, 2);

    const rawA = mockItem(app.mock, noteA.id)!;
    const bumpedATime = rawA.updatedTime + 5000;
    app.mock.items.set(`${noteA.id}.md`, {
      content: Buffer.from(
        serialize({
          type_: JoplinItemType.Note,
          title: 'Concurrent edit on A',
          body: rawA.body,
          properties: { ...rawA.properties, updated_time: new Date(bumpedATime).toISOString() },
        }),
        'utf8'
      ),
      contentType: 'text/plain; charset=utf-8',
      updatedTime: bumpedATime,
    });

    const undo2 = await app.api(`/api/organize/jobs/${job.id}/undo`, { method: 'POST' });
    assert.equal(undo2.status, 200);
    assert.equal(undo2.data.revertedCount, 1);
    assert.equal(undo2.data.conflictCount, 1);

    const finalA = (await app.api(`/api/notes/${noteA.id}`)).data;
    const finalB = (await app.api(`/api/notes/${noteB.id}`)).data;
    assert.equal(finalA.title, 'Concurrent edit on A');
    assert.equal(finalB.title, 'Edited externally B');
    assert.equal(finalB.parentId, demoId('nb-work'));
  });

  test('lists jobs via GET /api/organize/jobs and deletes finished jobs via ?remove=1', { timeout: TEST_TIMEOUT_MS }, async () => {
    const startRes = await app.api('/api/organize/jobs', {
      method: 'POST',
      body: JSON.stringify({ noteIds: [demoId('note-ramen')] }),
    });
    assert.equal(startRes.status, 201);
    const jobId = startRes.data.jobId as string;
    await pollUntilDone(jobId);

    const listRes = await app.api('/api/organize/jobs');
    assert.equal(listRes.status, 200);
    assert.ok(Array.isArray(listRes.data.jobs));
    const entry = listRes.data.jobs.find((j: any) => j.id === jobId);
    assert.ok(entry);
    assert.equal(entry.status, 'done');
    assert.equal(entry.progress.done, 1);
    assert.equal(typeof entry.createdAt, 'number');
    assert.equal(typeof entry.appliedCount, 'number');
    assert.equal(typeof entry.canUndo, 'boolean');

    const delRes = await app.api(`/api/organize/jobs/${jobId}?remove=1`, { method: 'DELETE' });
    assert.equal(delRes.status, 200);
    assert.deepEqual(delRes.data, { id: jobId, deleted: true });

    const missingRes = await app.api(`/api/organize/jobs/${jobId}`);
    assert.equal(missingRes.status, 404);
  });
});

describe('multi-job storage, v1 migration, lazy loading, 409 exclusivity, and retry', () => {
  test('migrates legacy v1 file atomically with zero data loss and lazy-loads finished jobs', { timeout: TEST_TIMEOUT_MS }, async () => {
    const migDir = mkdtempSync(join(tmpdir(), 'joplin-organize-mig-'));
    try {
      await noteCache.ensureFresh(session, 'force');
      const ownerKey = noteCache.getOwnerKey(session);
      const legacyDir = join(migDir, 'organize');
      mkdirSync(legacyDir, { recursive: true });

      const v1JobId = 'a1'.repeat(16);
      const v1Fixture = {
        version: 1,
        job: {
          id: v1JobId,
          ownerKey,
          status: 'done',
          excludeNotebookIds: [demoId('nb-work')],
          allowedNotebookIds: [demoId('nb-projects'), demoId('nb-reading')],
          systemPrompt: 'v1-system-prompt',
          usage: { promptTokens: 1200, completionTokens: 340, totalTokens: 1540 },
          lastUndo: {
            appliedAt: 1_700_000_009_000,
            items: [
              {
                noteId: demoId('note-scanned-invoice'),
                baseUpdatedTime: 2222,
                previousTitle: '2024_03_11.pdf',
                previousNotebookId: demoId('nb-work'),
                addedTags: ['invoice'],
              },
            ],
          },
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_010_000,
          items: [
            {
              noteId: demoId('note-scanned-invoice'),
              currentTitle: '2024_03_11.pdf',
              currentNotebookId: demoId('nb-work'),
              currentNotebookPath: 'Work',
              updatedTime: 2222,
              status: 'done',
              applied: true,
              applyStatus: 'ok',
              suggestion: {
                title: '2024-03-11 Acme Cloud – Invoice',
                notebookId: demoId('nb-projects'),
                tags: ['invoice', 'acme-cloud'],
                confidence: 0.92,
                documentDate: '2024-03-11',
                reason: 'Invoice OCR match.',
              },
            },
            {
              noteId: demoId('note-markdown-extras'),
              currentTitle: 'Markdown Extras: Math, Diagrams & More',
              currentNotebookId: demoId('nb-work'),
              currentNotebookPath: 'Work',
              updatedTime: 3333,
              status: 'failed',
              error: 'AI provider returned HTTP 402',
            },
            {
              noteId: demoId('note-roadmap'),
              currentTitle: 'Website Relaunch Roadmap',
              currentNotebookId: demoId('nb-projects'),
              currentNotebookPath: 'Work / Projects',
              updatedTime: 4444,
              status: 'failed',
              error: 'Duplicate copy (trashed)',
            },
          ],
        },
      };
      const legacyPath = join(legacyDir, `${ownerKey}.json`);
      writeFileSync(legacyPath, JSON.stringify(v1Fixture));

      const svc = trackService(
        new OrganizerService({
          aiBaseUrl: 'http://127.0.0.1:18317/v1',
          aiModel: 'deepseek-flash',
          aiFake: true,
          cacheDir: migDir,
        })
      );

      // Migration happens cleanly on list/attach; finished job stays out of RAM until accessed
      const listed = svc.listJobs(session);
      assert.equal(listed.jobs.length, 1);
      assert.equal(listed.jobs[0].id, v1JobId);
      assert.equal(listed.jobs[0].appliedCount, 1);
      assert.equal(listed.jobs[0].canUndo, true);
      assert.equal(existsSync(legacyPath), false, 'legacy v1 file removed after v2 writes succeed');
      assert.ok(existsSync(join(legacyDir, ownerKey, 'index.json')));
      assert.ok(existsSync(join(legacyDir, ownerKey, `${v1JobId}.json`)));
      assert.equal(svc.isJobLoadedInMemory(session, v1JobId), false, 'finished job is not loaded eagerly');

      // Lazy load restores every item, suggestion, applied flag, error, usage & undo record
      const loaded = await svc.getJob(session, v1JobId);
      assert.equal(svc.isJobLoadedInMemory(session, v1JobId), true);
      assert.equal(loaded.appliedCount, 1);
      assert.equal(loaded.retryableFailedCount, 1, 'excludes Duplicate copy (trashed)');
      assert.equal(loaded.canUndo, true);
      assert.deepEqual(loaded.usage, { promptTokens: 1200, completionTokens: 340, totalTokens: 1540 });
      const item = (key: string) => loaded.items.find((i) => i.noteId === demoId(key))!;
      assert.equal(item('note-scanned-invoice').applied, true);
      assert.equal(item('note-scanned-invoice').applyStatus, 'ok');
      assert.equal(item('note-scanned-invoice').suggestion?.title, '2024-03-11 Acme Cloud – Invoice');
      assert.equal(item('note-markdown-extras').error, 'AI provider returned HTTP 402');
      assert.equal(item('note-roadmap').error, 'Duplicate copy (trashed)');

      // Starting & finishing a second job keeps both and evicts the earlier finished job from RAM
      const second = await svc.startJob(session, { noteIds: [demoId('note-ramen')] });
      await svc.waitForIdle(session);
      assert.equal(svc.isJobLoadedInMemory(session, v1JobId), false, 'older finished job evicted from RAM');
      assert.equal(svc.isJobLoadedInMemory(session, second.jobId), true);

      const both = svc.listJobs(session);
      assert.equal(both.jobs.length, 2);
      assert.equal(both.jobs[0].id, second.jobId, 'newest first');
      assert.equal(both.jobs[1].id, v1JobId);

      // Re-reading v1 job reloads it cleanly from disk
      const reloaded = await svc.getJob(session, v1JobId);
      assert.equal(reloaded.id, v1JobId);
      assert.equal(svc.isJobLoadedInMemory(session, v1JobId), true);
    } finally {
      rmSync(migDir, { recursive: true, force: true });
    }
  });

  test('enforces one running job per user with 409, coexists finished jobs, caps retention at MAX_RETAINED_JOBS, and deletes finished jobs', { timeout: TEST_TIMEOUT_MS }, async () => {
    const capDir = mkdtempSync(join(tmpdir(), 'joplin-organize-cap-'));
    let server: Server | undefined;
    try {
      await noteCache.ensureFresh(session, 'force');
      const ownerKey = noteCache.getOwnerKey(session);

      let releaseRunning!: () => void;
      const runningStarted = new Promise<void>((resolve) => {
        releaseRunning = resolve;
      });
      let unblock!: () => void;
      const holdPromise = new Promise<void>((resolve) => {
        unblock = resolve;
      });

      const svc = trackService(
        new OrganizerService({
          aiBaseUrl: 'http://127.0.0.1:18317/v1',
          aiModel: 'deepseek-flash',
          aiConcurrency: 1,
          aiFake: false,
          cacheDir: capDir,
          completionFn: async (_msgs, signal) => {
            releaseRunning();
            await new Promise<void>((resolve, reject) => {
              holdPromise.then(resolve);
              if (signal.aborted) {
                reject(new DOMException('Aborted', 'AbortError'));
                return;
              }
              signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
            });
            return {
              content: JSON.stringify({
                title: 'Done Title',
                notebookId: demoId('nb-projects'),
                tags: ['other'],
                confidence: 0.9,
                documentDate: null,
                reason: 'Completed.',
              }),
              usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
            };
          },
        })
      );

      // Mount HTTP router with real auth + errorHandler for deterministic 409 testing
      const testExpress = express();
      testExpress.use(express.json());
      testExpress.use('/api/organize', createOrganizeRouter(svc));
      testExpress.use(errorHandler);
      server = testExpress.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server!.once('listening', resolve));
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      const req = async (path: string, init: RequestInit = {}): Promise<{ status: number; data: any }> => {
        const res = await fetch(`${baseUrl}${path}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${session}`,
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
            ...(init.headers as Record<string, string> | undefined),
          },
        });
        return { status: res.status, data: await res.json() };
      };

      const first = await req('/api/organize/jobs', {
        method: 'POST',
        body: JSON.stringify({ noteIds: [demoId('note-ramen')] }),
      });
      assert.equal(first.status, 201);
      await runningStarted;

      // Second job while first is running -> 409 with details.runningJobId
      const conflict = await req('/api/organize/jobs', {
        method: 'POST',
        body: JSON.stringify({ noteIds: [demoId('note-scanned-invoice')] }),
      });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.data.details.runningJobId, first.data.jobId);

      // Attempting to delete a running job with ?remove=1 -> 409
      const delRunning = await req(`/api/organize/jobs/${first.data.jobId}?remove=1`, { method: 'DELETE' });
      assert.equal(delRunning.status, 409);

      // Cancel running job, then start second job cleanly
      const cancelRes = await req(`/api/organize/jobs/${first.data.jobId}`, { method: 'DELETE' });
      assert.equal(cancelRes.status, 200);
      assert.equal(cancelRes.data.status, 'cancelled');
      unblock();

      const second = await req('/api/organize/jobs', {
        method: 'POST',
        body: JSON.stringify({ noteIds: [demoId('note-scanned-invoice')] }),
      });
      assert.equal(second.status, 201);

      const listRes = await req('/api/organize/jobs');
      assert.equal(listRes.status, 200);
      assert.equal(listRes.data.jobs.length, 2);
      assert.equal(listRes.data.jobs[0].id, second.data.jobId);
      assert.equal(listRes.data.jobs[1].id, first.data.jobId);

      // Delete first finished job cleanly
      const delFinished = await req(`/api/organize/jobs/${first.data.jobId}?remove=1`, { method: 'DELETE' });
      assert.equal(delFinished.status, 200);
      assert.equal(listRes.data.jobs.length - 1, (await req('/api/organize/jobs')).data.jobs.length);

      // Retention cap drops oldest finished jobs first while keeping up to MAX_RETAINED_JOBS (20)
      await svc.waitForIdle(session);
      await svc.shutdown();
      const capSvc = trackService(
        new OrganizerService({
          aiBaseUrl: 'http://127.0.0.1:18317/v1',
          aiModel: 'deepseek-flash',
          aiFake: true,
          cacheDir: capDir,
        })
      );
      const createdIds: string[] = [second.data.jobId];
      for (let i = 0; i < MAX_RETAINED_JOBS + 2; i++) {
        const res = await capSvc.startJob(session, { noteIds: [demoId('note-ramen')] });
        createdIds.push(res.jobId);
        await capSvc.waitForIdle(session);
      }
      const retained = capSvc.listJobs(session).jobs;
      assert.equal(retained.length, MAX_RETAINED_JOBS);
      assert.equal(retained[0].id, createdIds[createdIds.length - 1]);
      assert.equal(
        existsSync(join(capDir, 'organize', ownerKey, `${createdIds[0]}.json`)),
        false,
        'oldest finished job unlinked from disk'
      );
    } finally {
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server!.close(resolve));
      }
      rmSync(capDir, { recursive: true, force: true });
    }
  });

  test('retryJob re-queues only retryable failed items (not trashed/skipped), checks 409, and rebuilds system prompt from current notebooks byte-identically', { timeout: TEST_TIMEOUT_MS }, async () => {
    const retryDir = mkdtempSync(join(tmpdir(), 'joplin-organize-retry-'));
    let extraNbId = '';
    const extraNoteIds: string[] = [];
    try {
      // Create 3 notes cleanly in the mock Joplin Server
      const createNote = async (title: string, body: string) => {
        const res = await app.api('/api/notes', {
          method: 'POST',
          body: JSON.stringify({ parentId: demoId('nb-work'), title, body }),
        });
        assert.equal(res.status, 201);
        extraNoteIds.push(res.data.id);
        return res.data.id as string;
      };

      const retryNote1 = await createNote('Retry note 1', 'Invoice from Acme Cloud dated 2024-05-01.');
      const retryNote2 = await createNote('Retry note 2', 'Electricity utility statement.');
      const willTrashNote = await createNote('Will trash before retry', 'Temp document.');
      const skippedDuplicateNote = await createNote('Dup duplicate copy', 'Trashed duplicate content.');

      let phase: 'initial' | 'retry' = 'initial';
      const seenPromptsDuringRetry = new Set<string>();
      const seenUserTitlesDuringRetry: string[] = [];

      const svc = trackService(
        new OrganizerService({
          aiBaseUrl: 'http://127.0.0.1:18317/v1',
          aiModel: 'deepseek-flash',
          aiConcurrency: 1,
          aiFake: false,
          cacheDir: retryDir,
          completionFn: async (messages) => {
            const sys = messages.find((m) => m.role === 'system')?.content ?? '';
            const usr = messages.find((m) => m.role === 'user')?.content ?? '';
            if (phase === 'initial') {
              throw new Error('AI provider returned HTTP 503');
            }
            seenPromptsDuringRetry.add(sys);
            const m = /^Current title:\s*(.+)$/m.exec(usr);
            if (m) seenUserTitlesDuringRetry.push(m[1].trim());
            return {
              content: JSON.stringify({
                title: `Reorganized ${m?.[1]?.trim() ?? 'Doc'}`,
                notebookId: extraNbId || demoId('nb-projects'),
                tags: ['invoice'],
                confidence: 0.91,
                documentDate: '2024-05-01',
                reason: 'Retried after balance restored.',
              }),
              usage: { promptTokens: 100, completionTokens: 25, totalTokens: 125 },
            };
          },
        })
      );

      // Run initial job so notes fail with 503, plus seed one pre-existing non-retryable 'Duplicate copy (trashed)' error
      const { jobId } = await svc.startJob(session, {
        noteIds: [retryNote1, retryNote2, willTrashNote, skippedDuplicateNote],
        excludeNotebookIds: [demoId('nb-work')],
      });
      await svc.waitForIdle(session);

      // Simulate legacy/preflight "Duplicate copy (trashed)" error persisted on disk for skippedDuplicateNote
      await svc.shutdown();
      const ownerKey = noteCache.getOwnerKey(session);
      const jobPath = join(retryDir, 'organize', ownerKey, `${jobId}.json`);
      const persisted = JSON.parse(readFileSync(jobPath, 'utf8'));
      const dupItem = persisted.job.items.find((it: any) => it.noteId === skippedDuplicateNote);
      dupItem.error = 'Duplicate copy (trashed)';
      writeFileSync(jobPath, JSON.stringify(persisted));

      // Now create a brand-new notebook and trash willTrashNote in Joplin BEFORE retrying
      const nbRes = await app.api('/api/notebooks', {
        method: 'POST',
        body: JSON.stringify({ title: 'Tax Archive 2026' }),
      });
      assert.equal(nbRes.status, 201);
      extraNbId = nbRes.data.id;
      const trashRes = await app.api(`/api/notes/${willTrashNote}`, { method: 'DELETE' });
      assert.equal(trashRes.status, 204);

      // Fresh service loading from disk checks retryableFailedCount == 2 (not 4)
      const svc2 = trackService(
        new OrganizerService({
          aiBaseUrl: 'http://127.0.0.1:18317/v1',
          aiModel: 'deepseek-flash',
          aiConcurrency: 1,
          aiFake: false,
          cacheDir: retryDir,
          completionFn: async (messages) => {
            const sys = messages.find((m) => m.role === 'system')?.content ?? '';
            const usr = messages.find((m) => m.role === 'user')?.content ?? '';
            seenPromptsDuringRetry.add(sys);
            const m = /^Current title:\s*(.+)$/m.exec(usr);
            if (m) seenUserTitlesDuringRetry.push(m[1].trim());
            return {
              content: JSON.stringify({
                title: `Reorganized ${m?.[1]?.trim() ?? 'Doc'}`,
                notebookId: extraNbId,
                tags: ['invoice'],
                confidence: 0.91,
                documentDate: '2024-05-01',
                reason: 'Retried into new Tax Archive 2026 notebook.',
              }),
              usage: { promptTokens: 100, completionTokens: 25, totalTokens: 125 },
            };
          },
        })
      );

      phase = 'retry';
      const beforeRetry = await svc2.getJob(session, jobId);
      assert.equal(beforeRetry.retryableFailedCount, 2);

      const retried = await svc2.retryJob(session, jobId);
      assert.equal(retried.status, 'running');
      assert.equal(retried.requeuedCount, 2);

      // Calling retryJob or startJob while retry is running -> 409
      await assert.rejects(
        () => svc2.retryJob(session, jobId),
        (err: unknown) => err instanceof OrganizeValidationError && err.status === 409
      );

      await svc2.waitForIdle(session);
      const afterRetry = await svc2.getJob(session, jobId);
      assert.equal(afterRetry.status, 'done');
      assert.equal(afterRetry.progress.done, 2);
      assert.equal(afterRetry.progress.failed, 2);
      assert.equal(afterRetry.retryableFailedCount, 0);

      // Byte-identical system prompt across the entire resumed run, containing the brand new notebook
      assert.equal(seenPromptsDuringRetry.size, 1);
      const [retryPrompt] = [...seenPromptsDuringRetry];
      assert.match(retryPrompt, /Tax Archive 2026/);
      assert.deepEqual(seenUserTitlesDuringRetry.sort(), ['Retry note 1', 'Retry note 2']);
      assert.equal(afterRetry.items[0].suggestion?.notebookId, extraNbId);
      assert.equal(afterRetry.items[2].skipped, true);
    } finally {
      for (const nid of extraNoteIds) {
        app.mock.items.delete(`${nid}.md`);
      }
      if (extraNbId) {
        app.mock.items.delete(`${extraNbId}.md`);
      }
      await app.api('/api/notebooks/refresh', { method: 'POST' });
      rmSync(retryDir, { recursive: true, force: true });
    }
  });

  test('rejects noteIds and excludeNotebookIds arrays exceeding server bounds', { timeout: TEST_TIMEOUT_MS }, async () => {
    const tooManyNotes = Array.from({ length: MAX_ORGANIZE_NOTES + 1 }, () => demoId('note-ramen'));
    await assert.rejects(
      () => organizerService.startJob(session, { noteIds: tooManyNotes }),
      (err: unknown) => err instanceof OrganizeValidationError && err.status === 400
    );

    const tooManyExcludes = Array.from({ length: MAX_EXCLUDED_NOTEBOOKS + 1 }, () => demoId('nb-work'));
    await assert.rejects(
      () => organizerService.startJob(session, { noteIds: [demoId('note-ramen')], excludeNotebookIds: tooManyExcludes }),
      (err: unknown) => err instanceof OrganizeValidationError && err.status === 400
    );
  });
});

describe('whole-job filtering, apply targets, useSuggestion/undoMode, and chunked undo', () => {
  test('filters whole job server-side, returns unapplied targets, resolves useSuggestion with recurringTagFilter, appends undo across chunks, and undoes in chunks', { timeout: TEST_TIMEOUT_MS }, async () => {
    const chunkDir = mkdtempSync(join(tmpdir(), 'joplin-organize-chunks-'));
    let server: Server | undefined;
    const createdNoteIds: string[] = [];

    try {
      const makeNote = async (title: string, body: string, parentId = demoId('nb-work')) => {
        const res = await app.api('/api/notes', {
          method: 'POST',
          body: JSON.stringify({ parentId, title, body }),
        });
        assert.equal(res.status, 201);
        createdNoteIds.push(res.data.id);
        return res.data.id as string;
      };

      const nVeryHighApplied = await makeNote('vh_applied.pdf', 'Already applied note.');
      const nVeryHighPending = await makeNote('vh_pending.pdf', 'Pending very high note.');
      const nHighPending = await makeNote('high_pending.pdf', 'Pending high note.');
      const nLowPending = await makeNote('low_pending.pdf', 'Low confidence note.', demoId('nb-projects'));
      const nFailed = await makeNote('failed_note.pdf', 'Failing note.');

      const suggestionsByTitle: Record<
        string,
        { title: string; notebookId: string; tags: string[]; confidence: number }
      > = {
        'vh_applied.pdf': {
          title: '2025-01-01 Very High Applied',
          notebookId: demoId('nb-projects'),
          tags: ['invoice', 'rare-one-off'],
          confidence: 0.94,
        },
        'vh_pending.pdf': {
          title: '2025-01-02 Very High Pending',
          notebookId: demoId('nb-projects'),
          tags: ['invoice', 'rare-one-off'],
          confidence: 0.89,
        },
        'high_pending.pdf': {
          title: '2025-01-03 High Pending',
          notebookId: demoId('nb-reading'),
          tags: ['report', 'rare-one-off-2'],
          confidence: 0.76,
        },
        'low_pending.pdf': {
          title: '2025-01-04 Low Stays Put',
          notebookId: demoId('nb-projects'), // same notebook (not a move)
          tags: ['other'],
          confidence: 0.51,
        },
      };

      const svc = trackService(
        new OrganizerService({
          aiBaseUrl: 'http://127.0.0.1:18317/v1',
          aiModel: 'deepseek-flash',
          aiConcurrency: 1,
          aiFake: false,
          cacheDir: chunkDir,
          completionFn: async (messages) => {
            const usr = messages.find((m) => m.role === 'user')?.content ?? '';
            const m = /^Current title:\s*(.+)$/m.exec(usr);
            const curTitle = m?.[1]?.trim() ?? '';
            const cfg = suggestionsByTitle[curTitle];
            if (!cfg) {
              throw new Error('AI provider returned HTTP 500');
            }
            return {
              content: JSON.stringify({
                ...cfg,
                documentDate: '2025-01-01',
                reason: `Classified ${curTitle}`,
              }),
              usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
            };
          },
        })
      );

      const testExpress = express();
      testExpress.use(express.json());
      testExpress.use('/api/organize', createOrganizeRouter(svc));
      testExpress.use(errorHandler);
      server = testExpress.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server!.once('listening', resolve));
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      const req = async (path: string, init: RequestInit = {}): Promise<{ status: number; data: any }> => {
        const res = await fetch(`${baseUrl}${path}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${session}`,
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
            ...(init.headers as Record<string, string> | undefined),
          },
        });
        return { status: res.status, data: await res.json() };
      };

      const created = await req('/api/organize/jobs', {
        method: 'POST',
        body: JSON.stringify({
          noteIds: [nVeryHighApplied, nVeryHighPending, nHighPending, nLowPending, nFailed],
          excludeNotebookIds: [demoId('nb-work')],
        }),
      });
      assert.equal(created.status, 201);
      const jobId = created.data.jobId as string;
      await svc.waitForIdle(session);

      // Apply nVeryHighApplied upfront (page 1 already applied scenario)
      const preApply = await req(`/api/organize/jobs/${jobId}/apply`, {
        method: 'POST',
        body: JSON.stringify({ items: [{ noteId: nVeryHighApplied, useSuggestion: true }] }),
      });
      assert.equal(preApply.status, 200);
      assert.equal(preApply.data.appliedCount, 1);

      // Re-applying an applied row is skipped: it would record the AI title as the "previous" one
      const reApply = await req(`/api/organize/jobs/${jobId}/apply`, {
        method: 'POST',
        body: JSON.stringify({ items: [{ noteId: nVeryHighApplied, title: 'Clobbered', useSuggestion: true }] }),
      });
      assert.equal(reApply.status, 200);
      assert.equal(reApply.data.appliedCount, 0);
      assert.equal((await app.api(`/api/notes/${nVeryHighApplied}`)).data.title, '2025-01-01 Very High Applied');

      // Default GET reports full filterCounts across all 5 notes
      const fullJob = await req(`/api/organize/jobs/${jobId}`);
      assert.equal(fullJob.status, 200);
      assert.equal(fullJob.data.filter, 'all');
      assert.equal(fullJob.data.totalItems, 5);
      assert.equal(fullJob.data.progress.total, 5);
      assert.deepEqual(fullJob.data.filterCounts, {
        all: 5,
        veryHigh: 2,
        veryHighUnapplied: 1,
        high: 3,
        highUnapplied: 2,
        moves: 2,
        movesUnapplied: 2,
      });

      // Server-side ?filter=very-high&offset=1&limit=1 slices within filtered subset while keeping progress.total == 5
      const vhPage2 = await req(`/api/organize/jobs/${jobId}?filter=very-high&offset=1&limit=1`);
      assert.equal(vhPage2.status, 200);
      assert.equal(vhPage2.data.filter, 'very-high');
      assert.equal(vhPage2.data.totalItems, 2);
      assert.equal(vhPage2.data.progress.total, 5);
      assert.equal(vhPage2.data.items.length, 1);
      // Applied rows sink to the end, so the pending one is on page 1 and the applied one on page 2
      assert.equal(vhPage2.data.items[0].noteId, nVeryHighApplied);
      const vhPage1 = await req(`/api/organize/jobs/${jobId}?filter=very-high&offset=0&limit=1`);
      assert.equal(vhPage1.data.items[0].noteId, nVeryHighPending);

      const movesOnly = await req(`/api/organize/jobs/${jobId}?filter=moves`);
      assert.equal(movesOnly.status, 200);
      assert.equal(movesOnly.data.totalItems, 2);

      const badFilter = await req(`/api/organize/jobs/${jobId}?filter=unknown`);
      assert.equal(badFilter.status, 400);

      // GET /targets returns only unapplied done items >= threshold
      const badTargets = await req(`/api/organize/jobs/${jobId}/targets?mode=low`);
      assert.equal(badTargets.status, 400);

      const vhTargets = await req(`/api/organize/jobs/${jobId}/targets?mode=very-high`);
      assert.equal(vhTargets.status, 200);
      assert.deepEqual(vhTargets.data, { noteIds: [nVeryHighPending] });

      const highTargets = await req(`/api/organize/jobs/${jobId}/targets?mode=high`);
      assert.equal(highTargets.status, 200);
      assert.deepEqual(highTargets.data, { noteIds: [nVeryHighPending, nHighPending] });

      // Invalid undoMode -> 400
      const badUndoMode = await req(`/api/organize/jobs/${jobId}/apply`, {
        method: 'POST',
        body: JSON.stringify({ items: [{ noteId: nVeryHighPending, useSuggestion: true }], undoMode: 'merge' }),
      });
      assert.equal(badUndoMode.status, 400);

      // Chunk 1: apply nVeryHighPending with useSuggestion + undoMode='replace'
      // Verifies rare-one-off (< 3 occurrences, not existing tag) is dropped by recurringTagFilter while 'invoice' applies
      const applyChunk1 = await req(`/api/organize/jobs/${jobId}/apply`, {
        method: 'POST',
        body: JSON.stringify({
          items: [{ noteId: nVeryHighPending, useSuggestion: true }],
          undoMode: 'replace',
        }),
      });
      assert.equal(applyChunk1.status, 200);
      assert.equal(applyChunk1.data.appliedCount, 1);
      assert.equal(applyChunk1.data.canUndo, true);

      const noteVhpAfter = (await app.api(`/api/notes/${nVeryHighPending}`)).data;
      assert.equal(noteVhpAfter.title, '2025-01-02 Very High Pending');
      assert.equal(noteVhpAfter.parentId, demoId('nb-projects'));
      assert.deepEqual(
        noteVhpAfter.tags.map((t: any) => t.title),
        ['invoice']
      );

      // Chunk 2: apply nHighPending with useSuggestion + undoMode='append'
      const applyChunk2 = await req(`/api/organize/jobs/${jobId}/apply`, {
        method: 'POST',
        body: JSON.stringify({
          items: [{ noteId: nHighPending, useSuggestion: true }],
          undoMode: 'append',
        }),
      });
      assert.equal(applyChunk2.status, 200);
      assert.equal(applyChunk2.data.appliedCount, 1);
      assert.equal(applyChunk2.data.canUndo, true);

      const afterBoth = await req(`/api/organize/jobs/${jobId}`);
      assert.equal(afterBoth.data.filterCounts.veryHighUnapplied, 0);
      assert.equal(afterBoth.data.filterCounts.highUnapplied, 0);

      // Invalid limit on /undo -> 400
      const badUndoLimit = await req(`/api/organize/jobs/${jobId}/undo`, {
        method: 'POST',
        body: JSON.stringify({ limit: 0 }),
      });
      assert.equal(badUndoLimit.status, 400);

      // Chunked undo: limit=1 reverts first item and leaves remainingCount=1 + canUndo=true
      const undoChunk1 = await req(`/api/organize/jobs/${jobId}/undo`, {
        method: 'POST',
        body: JSON.stringify({ limit: 1 }),
      });
      assert.equal(undoChunk1.status, 200);
      assert.equal(undoChunk1.data.revertedCount, 1);
      assert.equal(undoChunk1.data.canUndo, true);
      assert.equal(undoChunk1.data.remainingCount, 1);

      // First note reverted, second note still applied
      const reverted1 = (await app.api(`/api/notes/${nVeryHighPending}`)).data;
      const stillApplied2 = (await app.api(`/api/notes/${nHighPending}`)).data;
      assert.equal(reverted1.title, 'vh_pending.pdf');
      assert.equal(stillApplied2.title, '2025-01-03 High Pending');

      // Undo chunk 2 reverts second note and clears undo
      const undoChunk2 = await req(`/api/organize/jobs/${jobId}/undo`, {
        method: 'POST',
        body: JSON.stringify({ limit: 1 }),
      });
      assert.equal(undoChunk2.status, 200);
      assert.equal(undoChunk2.data.revertedCount, 1);
      assert.equal(undoChunk2.data.canUndo, false);
      assert.equal(undoChunk2.data.remainingCount, 0);

      const reverted2 = (await app.api(`/api/notes/${nHighPending}`)).data;
      assert.equal(reverted2.title, 'high_pending.pdf');
      assert.equal(reverted2.parentId, demoId('nb-work'));

      // A note trashed after analysis is "gone": out of the open counts and targets, flagged, sorted last
      assert.equal((await app.api(`/api/notes/${nHighPending}`, { method: 'DELETE' })).status, 204);
      const afterTrash = await req(`/api/organize/jobs/${jobId}?filter=high`);
      assert.equal(afterTrash.data.goneCount, 1);
      assert.equal(afterTrash.data.filterCounts.high, 3);
      assert.equal(afterTrash.data.filterCounts.highUnapplied, 1);
      assert.equal(afterTrash.data.filterCounts.veryHighUnapplied, 1);
      assert.deepEqual(
        afterTrash.data.items.map((it: any) => [it.noteId, Boolean(it.gone), Boolean(it.applied)]),
        [
          [nVeryHighPending, false, false],
          [nVeryHighApplied, false, true],
          [nHighPending, true, false],
        ]
      );
      const highAfterTrash = await req(`/api/organize/jobs/${jobId}/targets?mode=high`);
      assert.deepEqual(highAfterTrash.data, { noteIds: [nVeryHighPending] });

      // Also verify main Express router mounts GET /targets cleanly
      const mainStart = await app.api('/api/organize/jobs', {
        method: 'POST',
        body: JSON.stringify({ noteIds: [demoId('note-scanned-invoice')] }),
      });
      assert.equal(mainStart.status, 201);
      await pollUntilDone(mainStart.data.jobId);
      const mainTargets = await app.api(`/api/organize/jobs/${mainStart.data.jobId}/targets?mode=very-high`);
      assert.equal(mainTargets.status, 200);
      assert.deepEqual(mainTargets.data, { noteIds: [demoId('note-scanned-invoice')] });
    } finally {
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server!.close(resolve));
      }
      for (const nid of createdNoteIds) {
        app.mock.items.delete(`${nid}.md`);
      }
      await app.api('/api/notebooks/refresh', { method: 'POST' });
      rmSync(chunkDir, { recursive: true, force: true });
    }
  });
});
