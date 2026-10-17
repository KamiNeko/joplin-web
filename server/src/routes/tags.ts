import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { noteCache } from '../services/note-cache.js';

const router = Router();

// Tags routes require an authenticated session
router.use(requireAuth);

/**
 * GET /api/tags
 * Returns all tags along with their corresponding note counts
 */
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const sessionId = req.sessionId!;
    const tags = await noteCache.getTags(sessionId);
    res.status(200).json(tags);
  } catch (error) {
    next(error);
  }
});

export const tagsRouter = router;
