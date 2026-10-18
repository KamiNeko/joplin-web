import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { noteCache } from '../services/note-cache.js';
import { noteWriter } from '../services/note-writer.js';
import { isTrueFlag } from './query.js';

const router = Router();

// Apply auth middleware to all notebook routes
router.use(requireAuth);

/**
 * GET /api/notebooks
 * Returns the nested notebook tree with note counts
 */
router.get('/', async (req, res) => {
  const tree = await noteCache.getNotebooks(req.sessionId!);
  res.status(200).json(tree);
});

/**
 * POST /api/notebooks/refresh
 * Forces a cache refresh for the active session
 */
router.post('/refresh', async (req, res) => {
  const sessionId = req.sessionId!;
  await noteCache.refreshCache(sessionId);
  const tree = await noteCache.getNotebooks(sessionId);
  res.status(200).json(tree);
});

/**
 * POST /api/notebooks
 * Creates a notebook. Body: { title, parentId? }
 */
router.post('/', async (req, res) => {
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
});

/**
 * PUT /api/notebooks/:id
 * Renames or re-parents a notebook. Body: { title?, parentId? }
 */
router.put('/:id', async (req, res) => {
  const { title, parentId } = req.body ?? {};
  const notebook = await noteWriter.updateNotebook(req.sessionId!, req.params.id, {
    title: typeof title === 'string' ? title : undefined,
    parentId: typeof parentId === 'string' ? parentId : undefined,
  });
  res.status(200).json(notebook);
});

/**
 * DELETE /api/notebooks/:id
 * Moves a notebook with its sub-notebooks and notes to the trash.
 * With ?permanent=true, deletes an already trashed notebook (and its contents) from the server.
 */
router.delete('/:id', async (req, res) => {
  const result = isTrueFlag(req.query.permanent)
    ? await noteWriter.purgeNotebook(req.sessionId!, req.params.id)
    : await noteWriter.trashNotebook(req.sessionId!, req.params.id);
  res.status(200).json(result);
});

export const notebooksRouter = router;
