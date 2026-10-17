import { Router, Request, Response, NextFunction } from 'express';
import { joplinApi, JoplinAuthError } from '../services/joplin-api.js';
import { noteCache } from '../services/note-cache.js';
import {
  cacheSessionValidation,
  invalidateSessionValidation,
  requireAuth,
} from '../middleware/auth.js';

const router = Router();

/**
 * POST /api/auth/login
 * Authenticates with Joplin Server using email and password
 */
router.post('/login', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    console.log(`[AuthRoute] Logging in user: ${email}`);
    const session = await joplinApi.createSession(email, password);

    // Cache the new session as valid
    cacheSessionValidation(session.sessionId, true);

    res.status(200).json({
      sessionId: session.sessionId,
      userId: session.userId,
    });
  } catch (error) {
    if (error instanceof JoplinAuthError) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }
    next(error);
  }
});

/**
 * POST /api/auth/logout
 * Clears cached session state and invalidates local cache
 */
router.post('/logout', (req: Request, res: Response): void => {
  let sessionId = req.sessionId;

  if (!sessionId) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
      sessionId = authHeader.substring(7).trim();
    }
  }

  if (sessionId) {
    console.log(`[AuthRoute] Logging out session: ${sessionId.substring(0, 8)}...`);
    invalidateSessionValidation(sessionId);
    noteCache.clearCache(sessionId);
  }

  res.status(200).json({ message: 'Successfully logged out' });
});

/**
 * GET /api/auth/check
 * Validates the currently active session
 */
router.get('/check', requireAuth, (req: Request, res: Response): void => {
  res.status(200).json({
    valid: true,
    sessionId: req.sessionId,
  });
});

export const authRouter = router;
