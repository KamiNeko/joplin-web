import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { noteCache } from '../services/note-cache.js';

const router = Router();

// Search routes require an authenticated session
router.use(requireAuth);

/**
 * GET /api/search?q=term (also accepts ?query=term)
 * Searches notes by title and body content, returning matching notes with match metadata
 */
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const sessionId = req.sessionId!;
    const raw = req.query.q ?? req.query.query;
    const query = typeof raw === 'string' ? raw : '';

    if (!query.trim()) {
      res.status(200).json([]);
      return;
    }

    const results = await noteCache.searchNotes(sessionId, query);
    res.status(200).json(results);
  } catch (error) {
    next(error);
  }
});

export const searchRouter = router;
