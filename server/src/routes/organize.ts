import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { organizerService, OrganizerService } from '../services/organizer.js';
import type { OrganizeFilter } from '../types/index.js';
import { isTrueFlag } from './query.js';

const VALID_ORGANIZE_FILTERS = new Set<OrganizeFilter>(['all', 'very-high', 'high', 'moves']);

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
   * GET /api/organize/jobs
   * Lists persisted and active Auto-organize jobs for the current user, newest first.
   */
  router.get('/jobs', (req, res) => {
    res.status(200).json(service.listJobs(req.sessionId!));
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
   * GET /api/organize/jobs/:id?offset=0&limit=100&filter=all
   * Returns job progress, filter counts, accumulated token usage, and paged suggestions with current metadata.
   */
  router.get('/jobs/:id', async (req, res) => {
    const rawOffset = req.query.offset;
    const rawLimit = req.query.limit;
    const rawFilter = req.query.filter;
    const offset = typeof rawOffset === 'string' && rawOffset.trim() !== '' ? Number(rawOffset) : 0;
    const limit = typeof rawLimit === 'string' && rawLimit.trim() !== '' ? Number(rawLimit) : 100;
    let filter: OrganizeFilter = 'all';
    if (rawFilter !== undefined) {
      if (typeof rawFilter !== 'string' || !VALID_ORGANIZE_FILTERS.has(rawFilter as OrganizeFilter)) {
        res.status(400).json({ error: 'filter must be one of all, very-high, high, moves' });
        return;
      }
      filter = rawFilter as OrganizeFilter;
    }
    if (!Number.isFinite(offset) || offset < 0) {
      res.status(400).json({ error: 'offset must be a non-negative integer' });
      return;
    }
    if (!Number.isFinite(limit) || limit < 1) {
      res.status(400).json({ error: 'limit must be a positive integer' });
      return;
    }
    const job = await service.getJob(req.sessionId!, req.params.id, { offset, limit, filter });
    res.status(200).json(job);
  });

  /**
   * GET /api/organize/jobs/:id/targets?mode=very-high
   * Returns all unapplied done noteIds matching the requested confidence threshold across the whole job.
   */
  router.get('/jobs/:id/targets', async (req, res) => {
    const mode = typeof req.query.mode === 'string' ? req.query.mode : '';
    if (mode !== 'very-high' && mode !== 'high') {
      res.status(400).json({ error: 'mode must be very-high or high' });
      return;
    }
    const result = await service.getApplyTargets(req.sessionId!, req.params.id, mode);
    res.status(200).json(result);
  });

  /**
   * DELETE /api/organize/jobs/:id
   * Cancels a running organize job, or deletes a finished job when `?remove=1` is passed.
   */
  router.delete('/jobs/:id', async (req, res) => {
    if (isTrueFlag(req.query.remove)) {
      const result = await service.deleteJob(req.sessionId!, req.params.id);
      res.status(200).json(result);
      return;
    }
    const result = await service.cancelJob(req.sessionId!, req.params.id);
    res.status(200).json(result);
  });

  /**
   * POST /api/organize/jobs/:id/retry
   * Re-queues retryable failed items (and resumes never-analysed ones of a cancelled job) using the
   * current notebook tree.
   */
  router.post('/jobs/:id/retry', async (req, res) => {
    const result = await service.retryJob(req.sessionId!, req.params.id);
    res.status(200).json(result);
  });

  /**
   * POST /api/organize/jobs/:id/apply
   * Body: { items: [{ noteId, title?, notebookId?, addTags?, baseUpdatedTime?, useSuggestion? }], undoMode? }
   * Applies approved suggestions via the batch writer and stores an undo record on the job.
   */
  router.post('/jobs/:id/apply', async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      res.status(400).json({ error: 'Request body must be a JSON object' });
      return;
    }
    const result = await service.applyJob(
      req.sessionId!,
      req.params.id,
      req.body as { items?: unknown; undoMode?: unknown }
    );
    res.status(200).json(result);
  });

  /**
   * POST /api/organize/jobs/:id/undo
   * Reverts the most recent apply action on this job (skipping notes changed since).
   * Optional body: { limit?: number } to revert in chunks.
   */
  router.post('/jobs/:id/undo', async (req, res) => {
    if (req.body !== undefined && (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body))) {
      res.status(400).json({ error: 'Request body must be a JSON object' });
      return;
    }
    const result = await service.undoJob(
      req.sessionId!,
      req.params.id,
      req.body as { limit?: unknown } | undefined
    );
    res.status(200).json(result);
  });

  return router;
}

export const organizeRouter = createOrganizeRouter();
