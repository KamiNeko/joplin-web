import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { noteCache } from '../services/note-cache.js';
import { noteWriter } from '../services/note-writer.js';

const router = Router();

// Apply auth middleware to all notebook routes
router.use(requireAuth);

/**
 * GET /api/notebooks
 * Returns the nested notebook tree with note counts
 */
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const sessionId = req.sessionId!;
    const tree = await noteCache.getNotebooks(sessionId);
    res.status(200).json(tree);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/notebooks/refresh
 * Forces a cache refresh for the active session
 */
router.post('/refresh', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const sessionId = req.sessionId!;
    await noteCache.refreshCache(sessionId);
    const tree = await noteCache.getNotebooks(sessionId);
    res.status(200).json(tree);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/notebooks
 * Creates a notebook. Body: { title, parentId? }
 */
router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { title, parentId } = req.body ?? {};
    if (typeof title !== 'string' || !title.trim()) {
      res.status(400).json({ error: 'title is required' });
      return;
    }
    const notebook = await noteWriter.createNotebook(req.sessionId!, {
      title,
      parentId: typeof parentId === 'string' ? parentId : '',
    });
    res.status(201).json(notebook);
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/notebooks/:id
 * Renames or re-parents a notebook. Body: { title?, parentId? }
 */
router.put('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { title, parentId } = req.body ?? {};
    const notebook = await noteWriter.updateNotebook(req.sessionId!, req.params.id, {
      title: typeof title === 'string' ? title : undefined,
      parentId: typeof parentId === 'string' ? parentId : undefined,
    });
    res.status(200).json(notebook);
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/notebooks/:id
 * Moves a notebook with its sub-notebooks and notes to the trash.
 * With ?permanent=true, deletes an already trashed notebook (and its contents) from the server.
 */
router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const permanent = req.query.permanent === 'true' || req.query.permanent === '1';
    const result = permanent
      ? await noteWriter.purgeNotebook(req.sessionId!, req.params.id)
      : await noteWriter.trashNotebook(req.sessionId!, req.params.id);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

export const notebooksRouter = router;
