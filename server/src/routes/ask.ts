import express, { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { askAiService, AskAiService } from '../services/ask-ai.js';
import { assertValidId, WriteValidationError } from '../services/note-writer.js';
import type { NoteAssistAction } from '../types/index.js';

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export function createAskRouter(service: AskAiService = askAiService): Router {
  const router = Router();
  router.use(requireAuth);

  /** GET /api/ai/status */
  router.get('/status', (_req, res) => {
    res.status(200).json(service.getStatus());
  });

  /** POST /api/ai/ask */
  router.post('/ask', async (req, res) => {
    const { question, scopeNotebookId, scopeTagId } = (req.body ?? {}) as {
      question?: unknown;
      scopeNotebookId?: unknown;
      scopeTagId?: unknown;
    };
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    const result = await service.askNotes(
      req.sessionId!,
      {
        question: typeof question === 'string' ? question : '',
        scopeNotebookId:
          typeof scopeNotebookId === 'string' && scopeNotebookId.trim()
            ? assertValidId(scopeNotebookId.trim(), 'notebook id')
            : undefined,
        scopeTagId:
          typeof scopeTagId === 'string' && scopeTagId.trim()
            ? assertValidId(scopeTagId.trim(), 'tag id')
            : undefined,
      },
      controller.signal
    );
    res.status(200).json(result);
  });

  /** POST /api/ai/note-assist */
  router.post('/note-assist', async (req, res) => {
    const { noteId, action } = (req.body ?? {}) as { noteId?: unknown; action?: unknown };
    const validNoteId = assertValidId(typeof noteId === 'string' ? noteId : undefined, 'note id');
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    const result = await service.noteAssist(
      req.sessionId!,
      { noteId: validNoteId, action: action as NoteAssistAction },
      controller.signal
    );
    res.status(200).json(result);
  });

  /**
   * POST /api/ai/transcribe
   * Accepts either raw audio bytes (application/octet-stream, audio/*, video/webm) with
   * X-File-Type header, or JSON { audioBase64, mime }.
   */
  router.post(
    '/transcribe',
    express.raw({
      type: ['application/octet-stream', 'audio/*', 'video/webm'],
      limit: MAX_AUDIO_BYTES,
    }),
    async (req, res) => {
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });

      let audioBuffer: Buffer;
      let mime: string;

      if (Buffer.isBuffer(req.body)) {
        audioBuffer = req.body;
        const headerType = req.headers['x-file-type'];
        const rawCt = req.headers['content-type'];
        const candidate =
          typeof headerType === 'string' && headerType.trim()
            ? headerType
            : typeof rawCt === 'string'
              ? rawCt
              : 'audio/wav';
        mime = candidate.split(';')[0].trim().toLowerCase() || 'audio/wav';
      } else if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
        const body = req.body as { audioBase64?: unknown; mime?: unknown };
        if (typeof body.audioBase64 !== 'string' || !body.audioBase64.trim()) {
          throw new WriteValidationError('audioBase64 or binary audio body is required', 400);
        }
        const stripped = body.audioBase64.replace(/^data:[^;]+;base64,/i, '').trim();
        audioBuffer = Buffer.from(stripped, 'base64');
        mime =
          typeof body.mime === 'string' && body.mime.trim()
            ? body.mime.split(';')[0].trim().toLowerCase()
            : 'audio/wav';
      } else {
        throw new WriteValidationError('Binary audio or JSON { audioBase64, mime } is required', 400);
      }

      const result = await service.transcribeAudio(audioBuffer, mime, controller.signal);
      res.status(200).json(result);
    }
  );

  return router;
}

export const askRouter = createAskRouter();
