import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { noteCache } from '../services/note-cache.js';
import { noteWriter } from '../services/note-writer.js';

const router = Router();

// Tags routes require an authenticated session
router.use(requireAuth);

/**
 * GET /api/tags
 * Returns all tags along with their corresponding note counts
 */
router.get('/', async (req, res) => {
  const tags = await noteCache.getTags(req.sessionId!);
  res.status(200).json(tags);
});

/**
 * PUT /api/tags/:id
 * Renames a tag. Body: { title }
 */
router.put('/:id', async (req, res) => {
  const { title } = req.body ?? {};
  if (typeof title !== 'string' || !title.trim()) {
    res.status(400).json({ error: 'title is required' });
    return;
  }
  const tag = await noteWriter.renameTag(req.sessionId!, req.params.id, title);
  res.status(200).json(tag);
});

/**
 * DELETE /api/tags/:id
 * Deletes a tag and removes it from all notes
 */
router.delete('/:id', async (req, res) => {
  const result = await noteWriter.deleteTag(req.sessionId!, req.params.id);
  res.status(200).json(result);
});

export const tagsRouter = router;
