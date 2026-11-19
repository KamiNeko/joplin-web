import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { buildDemoItems, demoId } from '../demo/seed.js';
import { startTestApp, type TestApp } from './helpers.js';

describe('instant OCR bridge and audio transcription integration', () => {
  let app: TestApp;
  let cacheDir: string;
  let ocrServer: Server;
  let aiServer: Server;

  let bridgeDelayMs = 0;
  let bridgeFailNext = false;
  let bridgeText = 'Scanned Receipt 2026';
  const ocrRequests: Array<{ secret: string | undefined; mime: string | undefined; size: number }> = [];
  const aiRequests: Array<{ auth: string | undefined; body: any }> = [];

  before(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), 'joplin-ocr-ai-'));

    ocrServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const buf = Buffer.concat(chunks);
        ocrRequests.push({
          secret: typeof req.headers['x-ocr-secret'] === 'string' ? req.headers['x-ocr-secret'] : undefined,
          mime: typeof req.headers['x-file-mime'] === 'string' ? req.headers['x-file-mime'] : undefined,
          size: buf.length,
        });
        if (req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        }
        if (req.headers['x-ocr-secret'] !== 'ocr-test-secret') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
          return;
        }
        const delay = bridgeDelayMs;
        setTimeout(() => {
          if (bridgeFailNext) {
            bridgeFailNext = false;
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'tesseract failed' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, text: bridgeText }));
        }, delay);
      });
    });
    await new Promise<void>((resolve) => ocrServer.listen(0, '127.0.0.1', resolve));
    const ocrPort = (ocrServer.address() as AddressInfo).port;

    aiServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        aiRequests.push({
          auth: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
          body,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: 'Transcript: hello team meeting' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          })
        );
      });
    });
    await new Promise<void>((resolve) => aiServer.listen(0, '127.0.0.1', resolve));
    const aiPort = (aiServer.address() as AddressInfo).port;

    process.env.OCR_SERVICE_URL = `http://127.0.0.1:${ocrPort}`;
    process.env.OCR_SERVICE_SECRET = 'ocr-test-secret';
    process.env.OCR_INLINE_WAIT_MS = '120';
    process.env.AI_BASE_URL = `http://127.0.0.1:${aiPort}/v1`;
    process.env.AI_API_KEY = 'test-ai-key';
    process.env.AI_MODEL = 'gemini-test';
    process.env.AI_TRANSCRIBE_MODEL = 'gemini-3.8-flash';
    delete process.env.AI_FAKE;

    app = await startTestApp({ items: buildDemoItems(), cacheDir, cacheTtlMs: 0 });
    await app.login();
  });

  after(async () => {
    await app.close();
    await new Promise((resolve) => ocrServer.close(resolve));
    await new Promise((resolve) => aiServer.close(resolve));
    rmSync(cacheDir, { recursive: true, force: true });
  });

  test('instant OCR runs inline on upload and makes extracted text searchable', async () => {
    bridgeDelayMs = 0;
    bridgeFailNext = false;
    bridgeText = 'Scanned Receipt 2026';

    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    const upload = await app.api('/api/resources', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': 'receipt.png',
        'X-File-Type': 'image/png',
      },
      body: pngBytes,
    });
    assert.equal(upload.status, 201);
    assert.equal(upload.data.ocrStatus, 'done');
    assert.equal(upload.data.ocrText, 'Scanned Receipt 2026');
    assert.ok(ocrRequests.some((r) => r.secret === 'ocr-test-secret' && r.mime === 'image/png'));

    const note = await app.api('/api/notes', {
      method: 'POST',
      body: JSON.stringify({
        parentId: demoId('nb-work'),
        title: 'Inline OCR Photo Note',
        body: `![receipt.png](:/${upload.data.id})`,
      }),
    });
    assert.equal(note.status, 201);

    const search = await app.api('/api/search?q=' + encodeURIComponent('Scanned Receipt 2026'));
    assert.equal(search.status, 200);
    assert.ok(search.data.some((n: any) => n.id === note.data.id));
  });

  test('slow OCR returns pending within inline timeout and finishes asynchronously', async () => {
    bridgeDelayMs = 350;
    bridgeFailNext = false;
    bridgeText = 'Async Delayed Invoice';

    const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n', 'utf8');
    const upload = await app.api('/api/resources', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': 'slow.pdf',
        'X-File-Type': 'application/pdf',
      },
      body: pdfBytes,
    });
    assert.equal(upload.status, 201);
    assert.equal(upload.data.ocrStatus, 'pending');

    const note = await app.api('/api/notes', {
      method: 'POST',
      body: JSON.stringify({
        parentId: demoId('nb-work'),
        title: 'Delayed PDF Note',
        body: `[slow.pdf](:/${upload.data.id})`,
      }),
    });
    assert.equal(note.status, 201);

    const initialAtts = await app.api(`/api/notes/${note.data.id}/attachments`);
    assert.equal(initialAtts.status, 200);
    assert.equal(initialAtts.data.length, 1);
    assert.equal(initialAtts.data[0].ocrStatus, 'pending');

    await new Promise((resolve) => setTimeout(resolve, 450));

    const doneAtts = await app.api(`/api/notes/${note.data.id}/attachments`);
    assert.equal(doneAtts.status, 200);
    assert.equal(doneAtts.data[0].ocrStatus, 'done');
    assert.equal(doneAtts.data[0].ocrText, 'Async Delayed Invoice');
  });

  test('failed OCR can be retried via POST /api/resources/:id/ocr', async () => {
    bridgeDelayMs = 0;
    bridgeFailNext = true;

    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
    const upload = await app.api('/api/resources', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': 'retry.png',
        'X-File-Type': 'image/png',
      },
      body: pngBytes,
    });
    assert.equal(upload.status, 201);
    assert.equal(upload.data.ocrStatus, 'failed');

    const note = await app.api('/api/notes', {
      method: 'POST',
      body: JSON.stringify({
        parentId: demoId('nb-work'),
        title: 'Retry OCR Note',
        body: `![retry.png](:/${upload.data.id})`,
      }),
    });
    assert.equal(note.status, 201);

    const beforeRetry = await app.api(`/api/notes/${note.data.id}/attachments`);
    assert.equal(beforeRetry.data[0].ocrStatus, 'failed');

    bridgeFailNext = false;
    bridgeText = 'Recovered Text';
    const retry = await app.api(`/api/resources/${upload.data.id}/ocr`, { method: 'POST' });
    assert.equal(retry.status, 200);
    assert.equal(retry.data.ocrStatus, 'done');
    assert.equal(retry.data.ocrText, 'Recovered Text');

    const afterRetry = await app.api(`/api/notes/${note.data.id}/attachments`);
    assert.equal(afterRetry.data[0].ocrStatus, 'done');
    assert.equal(afterRetry.data[0].ocrText, 'Recovered Text');
  });

  test('POST /api/ai/transcribe calls OpenAI-compatible input_audio with configured model', async () => {
    const status = await app.api('/api/ai/status');
    assert.equal(status.status, 200);
    assert.deepEqual(status.data, {
      enabled: true,
      model: 'gemini-test',
      transcribeEnabled: true,
      transcribeModel: 'gemini-3.8-flash',
    });

    const wavBytes = Buffer.from('RIFFdemoWAVEfmt data1234', 'utf8');
    const res = await app.api('/api/ai/transcribe', {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/wav',
        'X-File-Type': 'audio/wav',
      },
      body: wavBytes,
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.text, 'Transcript: hello team meeting');
    assert.equal(res.data.model, 'gemini-3.8-flash');

    const call = aiRequests.at(-1)!;
    assert.equal(call.auth, 'Bearer test-ai-key');
    assert.equal(call.body.model, 'gemini-3.8-flash');
    assert.equal(call.body.messages[0].role, 'system');
    assert.equal(call.body.messages[1].role, 'user');
    const audioPart = call.body.messages[1].content.find((p: any) => p.type === 'input_audio');
    assert.deepEqual(audioPart, {
      type: 'input_audio',
      input_audio: {
        data: wavBytes.toString('base64'),
        format: 'wav',
      },
    });
  });
});
