import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { noteWriter } from '../services/note-writer.js';

const router = Router();

router.use(requireAuth);

/**
 * GET /api/account/write-state
 * Whether Joplin Web may write to this account: `{ writable: true }`, or `{ writable: false, reason }`
 * when it is read-only (end-to-end encryption). Runs the same check as every write, so the client
 * can hide editing up front instead of failing each save with 422.
 */
router.get('/write-state', async (req, res) => {
  res.status(200).json(await noteWriter.getWriteState(req.sessionId!));
});

export const accountRouter = router;
