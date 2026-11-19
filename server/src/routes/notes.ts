import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { noteCache } from '../services/note-cache.js';
import { noteWriter } from '../services/note-writer.js';
import { ocrBridgeService } from '../services/ocr-bridge.js';
import { isTrueFlag } from './query.js';

const router = Router();

// All notes routes require an authenticated session
router.use(requireAuth);

/**
 * GET /api/notes
 * Returns a list of notes with preview snippets, sorted by updatedTime descending.
 * Query parameters:
 * - notebook_id | notebookId: filter notes in a specific notebook
 * - tag_id | tagId: filter notes linked to a specific tag
 * - is_trash | isTrash: set to 'true' or '1' to retrieve only trashed notes
 * - is_conflict | isConflict: set to 'true' or '1' to retrieve only conflict copies (Joplin's
 *   "Conflicts" folder); other filters are ignored then. Other lists never include them.
 */
router.get('/', async (req, res) => {
  const notebookId = (req.query.notebook_id || req.query.notebookId) as string | undefined;
  const tagId = (req.query.tag_id || req.query.tagId) as string | undefined;
  const isTrash = isTrueFlag(req.query.is_trash) || req.query.isTrash === 'true';
  const isConflict = isTrueFlag(req.query.is_conflict) || req.query.isConflict === 'true';

  const notes = await noteCache.getNotes(req.sessionId!, {
    notebookId: notebookId ? String(notebookId) : undefined,
    tagId: tagId ? String(tagId) : undefined,
    isTrash,
    isConflict,
  });

  res.status(200).json(notes);
});

/**
 * GET /api/notes/recent
 * Returns recently read notes (tracked by PreferencesStore) and recently created notes.
 * Must be registered before /:id so "recent" is not treated as a note ID.
 */
router.get('/recent', async (req, res) => {
  const rawLimit = req.query.limit;
  const limit =
    typeof rawLimit === 'string' && /^\d+$/.test(rawLimit.trim())
      ? Math.min(Math.max(1, parseInt(rawLimit.trim(), 10)), 100)
      : 50;
  const store = req.preferencesStore;
  const recentReads = store ? store.get(noteCache.getOwnerKey(req.sessionId!)).recentReads : [];
  const data = await noteCache.getRecentNotes(req.sessionId!, recentReads, limit);
  res.status(200).json(data);
});

/**
 * POST /api/notes/batch
 * Applies bulk edits across up to 1000 notes:
 * { items: [{ id, baseUpdatedTime?, parentId?, title?, addTags?, removeTags? }], parentId?, addTags?, removeTags?, trash?, restore? }
 * Responds with per-item results [{ id, status: "ok" | "conflict" | "error", updatedTime?, error?, addedTags? }].
 */
router.post('/batch', async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    res.status(400).json({ error: 'Request body must be a JSON object' });
    return;
  }
  const results = await noteWriter.batchUpdateNotes(req.sessionId!, req.body);
  res.status(200).json(results);
});

/**
 * GET /api/notes/:id
 * Returns the full note object including markdown body, parent notebook metadata, and linked tags
 */
router.get('/:id', async (req, res) => {
  const noteId = req.params.id;

  if (!noteId) {
    res.status(400).json({ error: 'Note ID is required' });
    return;
  }

  const note = await noteCache.getNote(req.sessionId!, noteId);

  if (!note) {
    res.status(404).json({ error: `Note not found with id: ${noteId}` });
    return;
  }

  res.status(200).json(note);
});

/**
 * POST /api/notes
 * Creates a note or to-do. Body: { title?, body?, parentId, isTodo? }
 */
router.post('/', async (req, res) => {
  const { title, body, parentId, isTodo } = req.body ?? {};
  if (typeof parentId !== 'string' || !parentId) {
    res.status(400).json({ error: 'parentId (notebook id) is required' });
    return;
  }
  const note = await noteWriter.createNote(req.sessionId!, {
    title: typeof title === 'string' ? title : '',
    body: typeof body === 'string' ? body : '',
    parentId,
    isTodo: Boolean(isTodo),
  });
  res.status(201).json(note);
});

/** Latest time a JavaScript Date can hold */
const MAX_DATE_MS = 8.64e15;

/**
 * Validates a `todoDue` request value: undefined leaves the due date as is, 0 or null clear it,
 * otherwise it must be an integer Unix ms timestamp. Returns null for invalid input.
 */
function parseTodoDue(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (value === null) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_DATE_MS) return null;
  return value;
}

/**
 * PUT /api/notes/:id
 * Updates a note. Body: { title?, body?, parentId?, todoCompleted?, todoDue?, baseUpdatedTime?, force? }
 * `todoDue` is a Unix ms timestamp, or 0 / null to clear the due date.
 * Responds 409 with details.current when the note changed since baseUpdatedTime.
 */
router.put('/:id', async (req, res) => {
  const { title, body, parentId, todoCompleted, todoDue, baseUpdatedTime, force } = req.body ?? {};
  const due = parseTodoDue(todoDue);
  if (due === null) {
    res.status(400).json({ error: 'todoDue must be a timestamp in milliseconds, 0 or null' });
    return;
  }
  const note = await noteWriter.updateNote(req.sessionId!, req.params.id, {
    title: typeof title === 'string' ? title : undefined,
    body: typeof body === 'string' ? body : undefined,
    parentId: typeof parentId === 'string' ? parentId : undefined,
    todoCompleted: typeof todoCompleted === 'boolean' ? todoCompleted : undefined,
    todoDue: due,
    baseUpdatedTime: typeof baseUpdatedTime === 'number' ? baseUpdatedTime : undefined,
    force: force === true,
  });
  res.status(200).json(note);
});

/**
 * DELETE /api/notes/:id
 * Moves the note to the trash, or deletes it from the server with ?permanent=true
 */
router.delete('/:id', async (req, res) => {
  if (isTrueFlag(req.query.permanent)) {
    await noteWriter.purgeNote(req.sessionId!, req.params.id);
  } else {
    await noteWriter.trashNote(req.sessionId!, req.params.id);
  }
  res.status(204).end();
});

/**
 * POST /api/notes/:id/tags
 * Adds a tag to a note by title (an existing tag is reused, matched case-insensitively). Body: { title }
 */
router.post('/:id/tags', async (req, res) => {
  const { title } = req.body ?? {};
  if (typeof title !== 'string' || !title.trim()) {
    res.status(400).json({ error: 'title is required' });
    return;
  }
  const note = await noteWriter.addTagToNote(req.sessionId!, req.params.id, title);
  res.status(200).json(note);
});

/**
 * DELETE /api/notes/:id/tags/:tagId
 * Removes a tag from a note
 */
router.delete('/:id/tags/:tagId', async (req, res) => {
  const note = await noteWriter.removeTagFromNote(req.sessionId!, req.params.id, req.params.tagId);
  res.status(200).json(note);
});

/**
 * POST /api/notes/:id/restore
 * Restores a note (and its trashed parent notebooks) from the trash
 */
router.post('/:id/restore', async (req, res) => {
  const note = await noteWriter.restoreNote(req.sessionId!, req.params.id);
  res.status(200).json(note);
});

/**
 * GET /api/notes/:id/attachments
 * Lists linked attachments and their cached OCR text for a note
 */
router.get('/:id/attachments', async (req, res) => {
  const attachments = await noteCache.getNoteAttachments(req.sessionId!, req.params.id);
  if (!attachments) {
    res.status(404).json({ error: `Note not found with id: ${req.params.id}` });
    return;
  }
  const hydrated = attachments.map((att) => {
    const live = ocrBridgeService.getStatus(att.id);
    if (live === 'pending') {
      return { ...att, ocrStatus: 'pending' as const };
    }
    const status = att.ocrStatus ?? live;
    return status ? { ...att, ocrStatus: status } : att;
  });
  res.status(200).json(hydrated);
});

/**
 * GET /api/notes/:id/revisions
 * Lists revision metadata for a note (newest first)
 */
router.get('/:id/revisions', async (req, res) => {
  const revisions = await noteCache.getNoteRevisions(req.sessionId!, req.params.id);
  if (!revisions) {
    res.status(404).json({ error: `Note not found with id: ${req.params.id}` });
    return;
  }
  res.status(200).json(revisions);
});

/**
 * GET /api/notes/:id/revisions/:revId
 * Reconstructs title and body for a specific revision
 */
router.get('/:id/revisions/:revId', async (req, res) => {
  const detail = await noteCache.getNoteRevisionDetail(req.sessionId!, req.params.id, req.params.revId);
  if (!detail) {
    res.status(404).json({ error: `Revision not found: ${req.params.revId}` });
    return;
  }
  res.status(200).json(detail);
});

/**
 * POST /api/notes/:id/revisions/:revId/restore
 * Restores a note's title and body from a saved revision
 */
router.post('/:id/revisions/:revId/restore', async (req, res) => {
  const { baseUpdatedTime, force } = (req.body ?? {}) as { baseUpdatedTime?: unknown; force?: unknown };
  const note = await noteWriter.restoreNoteRevision(req.sessionId!, req.params.id, req.params.revId, {
    baseUpdatedTime: typeof baseUpdatedTime === 'number' ? baseUpdatedTime : undefined,
    force: force === true,
  });
  res.status(200).json(note);
});

export const notesRouter = router;
