import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { demoId } from '../demo/seed.js';
import type { noteCache as NoteCacheInstance } from '../src/services/note-cache.js';
import type {
  buildOrganizeSystemPrompt as BuildOrganizeSystemPromptFn,
  buildOrganizeUserPrompt as BuildOrganizeUserPromptFn,
  isScannerStyleTitle as IsScannerStyleTitleFn,
  OrganizerService as OrganizerServiceClass,
  organizerService as OrganizerServiceInstance,
  parseAndValidateSuggestion as ParseAndValidateSuggestionFn,
  stripLinksFromBody as StripLinksFromBodyFn,
  LlmCompletionFn,
} from '../src/services/organizer.js';
import { serialize } from '../src/services/serializer.js';
import { JoplinItemType } from '../src/types/index.js';
import { mockItem, putMockItem, startTestApp, type TestApp } from './helpers.js';

let noteCache: typeof NoteCacheInstance;
let buildOrganizeSystemPrompt: typeof BuildOrganizeSystemPromptFn;
let buildOrganizeUserPrompt: typeof BuildOrganizeUserPromptFn;
let isScannerStyleTitle: typeof IsScannerStyleTitleFn;
let OrganizerService: typeof OrganizerServiceClass;
let organizerService: typeof OrganizerServiceInstance;
let parseAndValidateSuggestion: typeof ParseAndValidateSuggestionFn;
let stripLinksFromBody: typeof StripLinksFromBodyFn;

let tempCacheDir = '';
let app: TestApp;
let session = '';

before(async () => {
  tempCacheDir = mkdtempSync(join(tmpdir(), 'joplin-organize-test-'));
  process.env.AI_BASE_URL = 'http://127.0.0.1:18317/v1';
  process.env.AI_MODEL = 'deepseek-flash';
  process.env.AI_API_KEY = 'sk-test-secret-do-not-log';
  process.env.AI_CONCURRENCY = '2';
  process.env.AI_FAKE = '1';

  app = await startTestApp({ cacheDir: tempCacheDir, pageSize: 50 });
  ({ noteCache } = await import('../src/services/note-cache.js'));
  ({
    buildOrganizeSystemPrompt,
    buildOrganizeUserPrompt,
    isScannerStyleTitle,
    OrganizerService,
    organizerService,
    parseAndValidateSuggestion,
    stripLinksFromBody,
  } = await import('../src/services/organizer.js'));
  session = await app.login();
});

after(async () => {
  if (organizerService) {
    await organizerService.shutdown();
  }
  await app.close();
  if (tempCacheDir) {
    rmSync(tempCacheDir, { recursive: true, force: true });
  }
});

async function pollUntilDone(jobId: string, apiFn = app.api): Promise<any> {
  for (let i = 0; i < 60; i++) {
    const res = await apiFn(`/api/organize/jobs/${jobId}?offset=0&limit=100`);
    assert.equal(res.status, 200);
    if (res.data.status !== 'running') return res.data;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Organize job did not finish in time');
}

describe('Auto-organize unit checks: prompts & validation', () => {
  test('builds deterministic byte-identical system prompt, skips scanner titles, and excludes requested notebooks', async () => {
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
    // Descriptive note title in Projects appears in examples; scanner filename in Work/elsewhere does not
    assert.match(first.systemPrompt, /Website Relaunch Roadmap/);
    assert.doesNotMatch(first.systemPrompt, /2024_03_11\.pdf/);

    assert.equal(isScannerStyleTitle('2024_03_11.pdf'), true);
    assert.equal(isScannerStyleTitle('2024_03_11_14_22_05.pdf'), true);
    assert.equal(isScannerStyleTitle('IMG_20240101_120001'), true);
    assert.equal(isScannerStyleTitle('Website Relaunch Roadmap'), false);
  });

  test('strips links and caps body/OCR text cleanly in user prompt', async () => {
    const body = `See [Invoice Portal](https://billing.example.com/pay) and ![scan](:/${'a'.repeat(32)}) for ${'x'.repeat(2500)}`;
    const stripped = stripLinksFromBody(body, 1, 2000);
    assert.ok(stripped.length <= 2000);
    assert.ok(!stripped.includes('https://billing.example.com'));
    assert.ok(!stripped.includes(`:/${'a'.repeat(32)}`));
    assert.ok(stripped.includes('Invoice Portal'));

    const userPrompt = buildOrganizeUserPrompt({
      currentTitle: '2024_03_11.pdf',
      currentNotebookId: demoId('nb-work'),
      currentNotebookPath: 'Work',
      createdDate: '2024-03-11',
      bodyText: stripped,
      attachmentFilenames: ['2024_03_11.pdf'],
      ocrText: 'ACME CLOUD SERVICES INC. Total Paid: $420.00',
    });
    assert.match(userPrompt, /Current title: 2024_03_11\.pdf/);
    assert.match(userPrompt, /Current notebook: Work \(id: /);
    assert.match(userPrompt, /Attachment filenames:\n2024_03_11\.pdf/);
    assert.match(userPrompt, /ACME CLOUD SERVICES INC/);
  });

  test('validates JSON schema, strips extensions, enforces allowed notebooks & confidence fallback', () => {
    const allowed = new Set([demoId('nb-projects'), demoId('nb-personal')]);

    // Valid JSON wrapped in markdown fence + .pdf suffix + duplicate/mixed-case tags + 4 tags
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
      assert.deepEqual(good.suggestion.tags, ['finance', 'invoice', 'cloud']);
      assert.equal(good.suggestion.confidence, 0.91);
      assert.equal(good.suggestion.documentDate, '2024-03-11');
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
});

describe('OrganizerService: OpenAI HTTP client, retries, repairs, persistence and resume', () => {
  test('calls OpenAI-compatible Chat Completions with json_object format, retries 429/500 with backoff, never logs content or key', async () => {
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
      const svc = new OrganizerService({
        aiBaseUrl: `http://127.0.0.1:${llmPort}/v1`,
        aiApiKey: 'sk-super-secret-value',
        aiModel: 'deepseek-flash',
        aiConcurrency: 1,
        aiFake: false,
        cacheDir: null,
        sleep: async () => {},
        retryBaseDelayMs: 0,
      });

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
      await new Promise((resolve) => llmServer.close(resolve));
    }
  });

  test('repairs invalid JSON once, then marks item failed if second response is still invalid', async () => {
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

    const svc = new OrganizerService({
      aiBaseUrl: 'http://127.0.0.1:18317/v1',
      aiModel: 'deepseek-flash',
      aiConcurrency: 1,
      cacheDir: null,
      completionFn,
    });

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

  test('persists job under CACHE_DIR and resumes unfinished items on startup and session attach', async () => {
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

      const svc1 = new OrganizerService({
        aiBaseUrl: 'http://127.0.0.1:18317/v1',
        aiModel: 'deepseek-flash',
        aiConcurrency: 1,
        aiFake: false,
        cacheDir: tempCacheDir, // shares noteCache's ownerKey and saved cache file
        completionFn: interruptingClient,
      });

      const { jobId } = await svc1.startJob(session, {
        noteIds: [demoId('note-scanned-invoice'), demoId('note-markdown-extras')],
        excludeNotebookIds: [demoId('nb-work')],
      });
      await secondStarted;
      await svc1.shutdown();

      // Confirm persisted file shows job still running with item 0 done and item 1 pending
      const persistedPath = join(tempCacheDir, 'organize', `${ownerKey}.json`);
      const persisted = JSON.parse(readFileSync(persistedPath, 'utf8'));
      assert.equal(persisted.job.id, jobId);
      assert.equal(persisted.job.status, 'running');
      assert.equal(persisted.job.items[0].status, 'done');
      assert.equal(persisted.job.items[1].status, 'pending');

      // New service instance simulates server restart -> resumeFromDiskOnStartup finishes remaining work
      const svc2 = new OrganizerService({
        aiBaseUrl: 'http://127.0.0.1:18317/v1',
        aiModel: 'deepseek-flash',
        aiConcurrency: 2,
        aiFake: true,
        cacheDir: tempCacheDir,
      });
      svc2.resumeFromDiskOnStartup();
      await svc2.waitForIdle(session);
      const resumed = await svc2.getJob(session, jobId);
      assert.equal(resumed.status, 'done');
      assert.equal(resumed.progress.done, 2);

      // Isolate cross-session ownership with session-<sha256> when CACHE_DIR is omitted/custom session
      const svcSession = new OrganizerService({
        aiBaseUrl: 'http://127.0.0.1:18317/v1',
        aiModel: 'deepseek-flash',
        aiFake: true,
        cacheDir: isolatedCacheDir,
      });
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
  test('status returns enabled & model without leaking provider URL or key', async () => {
    const res = await app.api('/api/organize/status');
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { enabled: true, model: 'deepseek-flash' });
  });

  test('starts a job, pages suggestions, avoids excluded notebook, and supports cancel', async () => {
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

  test('cancels an in-flight running job via DELETE /api/organize/jobs/:id', async () => {
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

  test('applies suggestions with conflict isolation and reverts cleanly on undo (skipping changed notes)', async () => {
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
});
