import { Router } from 'express';
import { resolveWebAuthnRp, type AppConfig } from '../config.js';
import {
  cacheSessionValidation,
  getPendingToken,
  getSessionToken,
  getTrustedDeviceToken,
  invalidateSessionValidation,
  isWellFormedToken,
  requireAuth,
} from '../middleware/auth.js';
import {
  clearPendingCookies,
  clearSessionCookies,
  endJoplinSessionSafe,
  pendingCookie,
  sessionCookie,
} from '../services/auth-cookies.js';
import { joplinApi, JoplinAuthError } from '../services/joplin-api.js';
import { noteCache } from '../services/note-cache.js';
import { verifyTotp } from '../services/totp.js';
import { getEnrolledMethods, hasPrimaryFactor, TwoFactorStore } from '../services/two-factor-store.js';
import { createTwoFactorRouter } from './two-factor.js';

export { sessionCookie };

/**
 * Builds the /api/auth router
 */
export function createAuthRouter(
  config: AppConfig,
  store: TwoFactorStore = new TwoFactorStore(config.cacheDir)
): Router {
  // Shown in the client's connection status; only sent to signed-in users
  const serverHost = new URL(config.joplinServerUrl).host;
  const router = Router();

  /**
   * POST /api/auth/login
   * Authenticates with Joplin Server using email and password.
   * When 2FA is active or required, browser logins enter a server-side pending state (httpOnly
   * `pending` cookie, no session cookie) until verified or enrolled. Non-browser API clients (no
   * Origin header) may pass `totpCode` or `recoveryCode` in the body for single-call authentication.
   */
  router.post('/login', async (req, res) => {
    try {
      const { email, password, totpCode, recoveryCode } = req.body ?? {};

      if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
        res.status(400).json({ error: 'Email and password are required' });
        return;
      }
      if (totpCode !== undefined && typeof totpCode !== 'string') {
        res.status(400).json({ error: 'Invalid totpCode format' });
        return;
      }
      if (recoveryCode !== undefined && typeof recoveryCode !== 'string') {
        res.status(400).json({ error: 'Invalid recoveryCode format' });
        return;
      }
      const hasTotpCode = typeof totpCode === 'string' && totpCode.trim().length > 0;
      const hasRecoveryCode = typeof recoveryCode === 'string' && recoveryCode.trim().length > 0;
      if (hasTotpCode && hasRecoveryCode) {
        res.status(400).json({ error: 'Provide either totpCode or recoveryCode, not both' });
        return;
      }

      const session = await joplinApi.createSession(email, password);

      try {
        const activeStore = req.twoFactorStore ?? store;
        const { token: previousPendingToken } = getPendingToken(req);
        if (previousPendingToken) {
          const prev = activeStore.deletePendingLogin(previousPendingToken);
          if (prev) await endJoplinSessionSafe(prev.joplinSessionId);
        }

        const record = config.cacheDir ? activeStore.getUserRecord(session.userId) : null;
        const userHas2fa = record ? hasPrimaryFactor(record) : false;
        const requiresTwoFactor = userHas2fa || config.require2fa;
        const mustEnroll = config.require2fa && !userHas2fa;
        const methods = record ? getEnrolledMethods(record) : [];
        const isApiClient = req.headers.origin === undefined;

        if (!requiresTwoFactor) {
          cacheSessionValidation(session.sessionId, true, req.authState, config.authCacheTtlMs);
          activeStore.recordSession(session.sessionId, {
            userId: session.userId,
            email,
            twoFactorPassed: true,
            lastSecondFactorAt: null,
          });
          console.log(`[AuthRoute] Login succeeded, session ${session.sessionId.substring(0, 8)}...`);

          const cookie = sessionCookie(config, req);
          clearSessionCookies(res, cookie.name);
          clearPendingCookies(res);
          res.cookie(cookie.name, session.sessionId, cookie.options);
          res.status(200).json({
            userId: session.userId,
            ...(isApiClient ? { sessionId: session.sessionId } : {}),
          });
          return;
        }

        // API client one-call 2FA flow (no Origin header)
        if (isApiClient) {
          if (mustEnroll) {
            await endJoplinSessionSafe(session.sessionId);
            res.status(401).json({
              error: 'Two-factor authentication enrollment is required. Sign in via the web UI first.',
              twoFactor: { required: true, methods: [], mustEnroll: true },
            });
            return;
          }

          let verified = false;
          if (hasTotpCode) {
            verified = await activeStore.withUserLock(session.userId, () => {
              const latest = activeStore.getUserRecord(session.userId);
              if (!latest.totp) return false;
              const check = verifyTotp(latest.totp.secret, totpCode!, {
                lastUsedStep: latest.totp.lastUsedStep,
              });
              if (!check.valid || check.step === null) return false;
              latest.totp = { ...latest.totp, lastUsedStep: check.step };
              activeStore.saveUserRecord(latest);
              return true;
            });
          } else if (hasRecoveryCode) {
            const recovery = await activeStore.verifyAndConsumeRecoveryCode(session.userId, recoveryCode!);
            verified = recovery.valid;
          }

          if (!verified) {
            await endJoplinSessionSafe(session.sessionId);
            res.status(401).json({
              error: hasTotpCode || hasRecoveryCode
                ? 'Invalid two-factor verification code'
                : 'Two-factor authentication required',
              twoFactor: { required: true, methods, mustEnroll: false },
            });
            return;
          }

          cacheSessionValidation(session.sessionId, true, req.authState, config.authCacheTtlMs);
          activeStore.recordSession(session.sessionId, {
            userId: session.userId,
            email,
            twoFactorPassed: true,
            lastSecondFactorAt: Date.now(),
          });
          console.log(`[AuthRoute] Login succeeded, session ${session.sessionId.substring(0, 8)}...`);

          const cookie = sessionCookie(config, req);
          clearSessionCookies(res, cookie.name);
          clearPendingCookies(res);
          res.cookie(cookie.name, session.sessionId, cookie.options);
          res.status(200).json({
            userId: session.userId,
            sessionId: session.sessionId,
          });
          return;
        }

        // Browser flow: check optional 30-day trusted-device cookie when 2FA is already enrolled
        if (!mustEnroll && userHas2fa && config.cacheDir) {
          const { token: tdToken, duplicateCookies: duplicateTd } = getTrustedDeviceToken(req);
          if (tdToken && !duplicateTd) {
            const matchedId = await activeStore.verifyTrustedDevice(session.userId, tdToken);
            if (matchedId) {
              cacheSessionValidation(session.sessionId, true, req.authState, config.authCacheTtlMs);
              activeStore.recordSession(session.sessionId, {
                userId: session.userId,
                email,
                // Trusted device bypasses login prompt, but Settings mutations still require step-up
                twoFactorPassed: true,
                lastSecondFactorAt: null,
              });
              console.log(`[AuthRoute] Trusted-device login succeeded, session ${session.sessionId.substring(0, 8)}...`);

              const cookie = sessionCookie(config, req);
              clearSessionCookies(res, cookie.name);
              clearPendingCookies(res);
              res.cookie(cookie.name, session.sessionId, cookie.options);
              res.status(200).json({ userId: session.userId });
              return;
            }
          }
        }

        // Browser 2FA step required: hold Joplin session server-side behind a pending cookie
        clearSessionCookies(res);
        const { token: pendingToken, evictedSessions } = activeStore.createPendingLogin({
          joplinSessionId: session.sessionId,
          userId: session.userId,
          email,
          mustEnroll,
          methods,
        });
        for (const evictedSessionId of evictedSessions) {
          await endJoplinSessionSafe(evictedSessionId);
        }

        const pCookie = pendingCookie(config, req);
        clearPendingCookies(res, pCookie.name);
        res.cookie(pCookie.name, pendingToken, pCookie.options);

        res.status(200).json({
          twoFactor: {
            required: true,
            methods,
            mustEnroll,
            passkeysAvailable: Boolean(resolveWebAuthnRp(config, req.headers.origin)),
          },
        });
      } catch (err) {
        await endJoplinSessionSafe(session.sessionId);
        throw err;
      }
    } catch (error) {
      if (error instanceof JoplinAuthError) {
        console.log('[AuthRoute] Login failed: invalid credentials');
        res.status(401).json({ error: 'Invalid email or password' });
        return;
      }
      throw error;
    }
  });

  /**
   * POST /api/auth/logout
   * Ends the session (or pending 2FA login) on Joplin Server, drops all cached state and clears cookies.
   * Succeeds even if Joplin Server can't be reached; the session is then still rejected locally.
   */
  router.post('/logout', async (req, res) => {
    const activeStore = req.twoFactorStore ?? store;
    const { token: sessionId } = getSessionToken(req);
    const { token: pendingToken } = getPendingToken(req);
    clearSessionCookies(res);
    clearPendingCookies(res);

    // Malformed tokens are never cached or sent upstream (unauthenticated callers could flood both)
    if (sessionId && isWellFormedToken(sessionId)) {
      console.log(`[AuthRoute] Logging out session: ${sessionId.substring(0, 8)}...`);
      invalidateSessionValidation(sessionId, req.authState, activeStore);
      noteCache.clearCache(sessionId);
      await endJoplinSessionSafe(sessionId);
    }

    if (pendingToken) {
      const pending = activeStore.deletePendingLogin(pendingToken);
      if (pending) {
        await endJoplinSessionSafe(pending.joplinSessionId);
      }
    }

    res.status(200).json({ message: 'Successfully logged out' });
  });

  /**
   * GET /api/auth/check
   * Validates the current session and returns the Joplin Server host for display. The token itself
   * is never echoed back.
   */
  router.get('/check', requireAuth, (_req, res) => {
    res.status(200).json({ valid: true, serverHost });
  });

  router.use('/2fa', createTwoFactorRouter(config, store));

  return router;
}
