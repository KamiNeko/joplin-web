import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { noteCache } from '../services/note-cache.js';
import { noteWriter } from '../services/note-writer.js';
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

export const notesRouter = router;
