import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { noteCache } from '../services/note-cache.js';

const router = Router();

// All notes routes require an authenticated session
router.use(requireAuth);

/**
 * GET /api/notes
 * Returns a list of notes with preview snippets, sorted by updatedTime descending.
 * Query parameters:
 * - notebook_id | notebookId: filter notes in a specific notebook
 * - tag_id | tagId: filter notes linked to a specific tag
 */
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const sessionId = req.sessionId!;
    const notebookId = (req.query.notebook_id || req.query.notebookId) as string | undefined;
    const tagId = (req.query.tag_id || req.query.tagId) as string | undefined;

    const notes = await noteCache.getNotes(sessionId, {
      notebookId: notebookId ? String(notebookId) : undefined,
      tagId: tagId ? String(tagId) : undefined,
    });

    res.status(200).json(notes);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/notes/:id
 * Returns the full note object including markdown body, parent notebook metadata, and linked tags
 */
router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const sessionId = req.sessionId!;
    const noteId = req.params.id;

    if (!noteId) {
      res.status(400).json({ error: 'Note ID is required' });
      return;
    }

    const note = await noteCache.getNote(sessionId, noteId);

    if (!note) {
      res.status(404).json({ error: `Note not found with id: ${noteId}` });
      return;
    }

    res.status(200).json(note);
  } catch (error) {
    next(error);
  }
});

export const notesRouter = router;
