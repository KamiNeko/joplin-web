import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { organizerService, OrganizerService } from '../services/organizer.js';

export function createOrganizeRouter(service: OrganizerService = organizerService): Router {
  const router = Router();

  // Every organize endpoint requires an authenticated session
  router.use(requireAuth);

  /**
   * GET /api/organize/status
   * Tells the client whether Auto-organize is configured and active (never exposes URLs or secrets).
   */
  router.get('/status', (req, res) => {
    res.status(200).json(service.getStatus(req.sessionId!));
  });

  /**
   * POST /api/organize/jobs
   * Body: { noteIds: string[], excludeNotebookIds?: string[] }
   * Starts a background organize job and returns { jobId }.
   */
  router.post('/jobs', async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      res.status(400).json({ error: 'Request body must be a JSON object' });
      return;
    }
    const { noteIds, excludeNotebookIds } = req.body as {
      noteIds?: unknown;
      excludeNotebookIds?: unknown;
    };
    const result = await service.startJob(req.sessionId!, { noteIds, excludeNotebookIds });
    res.status(201).json(result);
  });

  /**
   * GET /api/organize/jobs/:id?offset=0&limit=100
   * Returns job progress, accumulated token usage, and paged suggestions with current metadata.
   */
  router.get('/jobs/:id', async (req, res) => {
    const rawOffset = req.query.offset;
    const rawLimit = req.query.limit;
    const offset = typeof rawOffset === 'string' && rawOffset.trim() !== '' ? Number(rawOffset) : 0;
    const limit = typeof rawLimit === 'string' && rawLimit.trim() !== '' ? Number(rawLimit) : 100;
    if (!Number.isFinite(offset) || offset < 0) {
      res.status(400).json({ error: 'offset must be a non-negative integer' });
      return;
    }
    if (!Number.isFinite(limit) || limit < 1) {
      res.status(400).json({ error: 'limit must be a positive integer' });
      return;
    }
    const job = await service.getJob(req.sessionId!, req.params.id, { offset, limit });
    res.status(200).json(job);
  });

  /**
   * DELETE /api/organize/jobs/:id
   * Cancels a running organize job.
   */
  router.delete('/jobs/:id', async (req, res) => {
    const result = await service.cancelJob(req.sessionId!, req.params.id);
    res.status(200).json(result);
  });

  /**
   * POST /api/organize/jobs/:id/apply
   * Body: { items: [{ noteId, title?, notebookId?, addTags?, baseUpdatedTime? }] }
   * Applies approved suggestions via the batch writer and stores an undo record on the job.
   */
  router.post('/jobs/:id/apply', async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      res.status(400).json({ error: 'Request body must be a JSON object' });
      return;
    }
    const result = await service.applyJob(req.sessionId!, req.params.id, req.body as { items?: unknown });
    res.status(200).json(result);
  });

  /**
   * POST /api/organize/jobs/:id/undo
   * Reverts the most recent apply action on this job (skipping notes changed since).
   */
  router.post('/jobs/:id/undo', async (req, res) => {
    const result = await service.undoJob(req.sessionId!, req.params.id);
    res.status(200).json(result);
  });

  return router;
}

export const organizeRouter = createOrganizeRouter();
