import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { noteCache } from '../services/note-cache.js';

const router = Router();

// Search routes require an authenticated session
router.use(requireAuth);

/**
 * GET /api/search?q=term (also accepts ?query=term)
 * Searches notes by title and body content, returning matching notes with match metadata
 */
router.get('/', async (req, res) => {
  const raw = req.query.q ?? req.query.query;
  const query = typeof raw === 'string' ? raw : '';

  if (!query.trim()) {
    res.status(200).json([]);
    return;
  }

  const results = await noteCache.searchNotes(req.sessionId!, query);
  res.status(200).json(results);
});

export const searchRouter = router;
