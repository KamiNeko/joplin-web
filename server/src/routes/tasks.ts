import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { setInlineTaskChecked } from '../services/inline-tasks.js';
import { noteCache } from '../services/note-cache.js';
import { assertValidId, noteWriter } from '../services/note-writer.js';

const router = Router();
router.use(requireAuth);

/**
 * GET /api/tasks
 * Returns unified Joplin to-do notes and interactive GFM inline checklist items across active notes.
 */
router.get('/', async (req, res) => {
  const tasks = await noteCache.getAllTasks(req.sessionId!);
  res.status(200).json(tasks);
});

/**
 * POST /api/tasks/toggle
 * Toggles an inline GFM checklist item inside a note atomically against `baseUpdatedTime`.
 * Body: { noteId, line, column, checked, baseUpdatedTime? }
 */
router.post('/toggle', async (req, res) => {
  const { noteId, line, column, checked, baseUpdatedTime } = (req.body ?? {}) as {
    noteId?: unknown;
    line?: unknown;
    column?: unknown;
    checked?: unknown;
    baseUpdatedTime?: unknown;
  };
  const validNoteId = assertValidId(typeof noteId === 'string' ? noteId : undefined, 'note id');
  if (
    typeof line !== 'number' ||
    typeof column !== 'number' ||
    !Number.isInteger(line) ||
    !Number.isInteger(column) ||
    typeof checked !== 'boolean'
  ) {
    res.status(400).json({ error: 'line (integer), column (integer), and checked (boolean) are required' });
    return;
  }

  const current = await noteCache.getNote(req.sessionId!, validNoteId);
  if (!current) {
    res.status(404).json({ error: `Note not found with id: ${validNoteId}` });
    return;
  }

  const nextBody = setInlineTaskChecked(current.body, line, column, checked);
  if (nextBody === null) {
    res.status(409).json({
      error: 'The task line moved or changed; refresh before toggling',
      details: { conflict: true, current },
    });
    return;
  }

  const updated = await noteWriter.updateNote(req.sessionId!, validNoteId, {
    body: nextBody,
    baseUpdatedTime: typeof baseUpdatedTime === 'number' ? baseUpdatedTime : current.updatedTime,
  });
  res.status(200).json(updated);
});

export const tasksRouter = router;
