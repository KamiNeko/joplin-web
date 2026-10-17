import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { noteCache } from '../services/note-cache.js';

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

export const notebooksRouter = router;
