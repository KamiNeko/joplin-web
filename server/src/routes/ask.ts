import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { askAiService, AskAiService } from '../services/ask-ai.js';
import { assertValidId } from '../services/note-writer.js';
import type { NoteAssistAction } from '../types/index.js';

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
    req.on('close', () => controller.abort());
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
    req.on('close', () => controller.abort());
    const result = await service.noteAssist(
      req.sessionId!,
      { noteId: validNoteId, action: action as NoteAssistAction },
      controller.signal
    );
    res.status(200).json(result);
  });

  return router;
}

export const askRouter = createAskRouter();
