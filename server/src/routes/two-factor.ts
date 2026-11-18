import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { Request, Response, Router } from 'express';
import { isWebAuthnConfigured, resolveWebAuthnRp, type AppConfig } from '../config.js';
import {
  authenticateSession,
  getHeaderSessionToken,
  getPendingToken,
  getSessionToken,
  getTrustedDeviceToken,
  invalidateSessionValidation,
  requireAuth,
} from '../middleware/auth.js';
import {
  clearPendingCookies,
  clearTrustedDeviceCookies,
  endJoplinSessionSafe,
  promotePendingLogin,
} from '../services/auth-cookies.js';
import { buildOtpauthUri, generateQrSvgDataUrl, generateTotpSecret, verifyTotp } from '../services/totp.js';
import {
  clearFailedSecondFactor,
  generateRecoveryCodes,
  getEnrolledMethods,
  getLockoutRetryAfterSeconds,
  hasPrimaryFactor,
  PendingLogin,
  recordFailedSecondFactor,
  STEP_UP_TTL_MS,
  TwoFactorStore,
  WEBAUTHN_CHALLENGE_TTL_MS,
} from '../services/two-factor-store.js';

function sanitizePasskeyName(raw: unknown, fallbackIndex: number): string {
  if (typeof raw === 'string') {
    const trimmed = raw.trim().slice(0, 64);
    if (trimmed) return trimmed;
  }
  return `Passkey ${fallbackIndex}`;
}

function userIdBytesForWebAuthn(userId: string): Uint8Array<ArrayBuffer> {
  const utf8 = Buffer.from(userId, 'utf8');
  // WebAuthn limits userHandle / user.id to 64 bytes
  const slice = utf8.length <= 64 ? utf8 : utf8.subarray(0, 64);
  const out = new Uint8Array(new ArrayBuffer(slice.length));
  out.set(slice);
  return out;
}

function isStepUpFresh(store: TwoFactorStore, sessionId: string, now = Date.now()): { valid: boolean; expiresAt: number | null } {
  const session = store.getSession(sessionId);
  if (!session || session.lastSecondFactorAt === null) {
    return { valid: false, expiresAt: null };
  }
  const expiresAt = session.lastSecondFactorAt + STEP_UP_TTL_MS;
  return expiresAt > now ? { valid: true, expiresAt } : { valid: false, expiresAt: null };
}

/**
 * Loads an active, non-expired, single-use pending login from the request's pending cookie.
 * Derives `mustEnroll` from the live user record (not stale login-time state) and sends an HTTP
 * error response (cleaning up expired upstream Joplin sessions) if invalid.
 */
async function loadPendingLogin(
  req: Request,
  res: Response,
  config: AppConfig,
  store: TwoFactorStore,
  options: { requireMustEnroll?: boolean; requireAlreadyEnrolled?: boolean } = {}
): Promise<PendingLogin | null> {
  const { token, duplicateCookies } = getPendingToken(req);
  if (duplicateCookies) {
    clearPendingCookies(res);
    res.status(401).json({
      error: 'Conflicting verification cookies. Please sign in again.',
      expired: true,
    });
    return null;
  }
  if (!token) {
    res.status(401).json({
      error: 'Two-factor verification session expired or missing. Please sign in again.',
      expired: true,
    });
    return null;
  }

  const pending = store.getPendingLogin(token);
  if (!pending || pending.consumed) {
    clearPendingCookies(res);
    res.status(401).json({
      error: 'Two-factor verification session expired or already used. Please sign in again.',
      expired: true,
    });
    return null;
  }

  if (pending.expiresAt <= Date.now()) {
    store.deletePendingByHash(pending.tokenHash);
    await endJoplinSessionSafe(pending.joplinSessionId);
    clearPendingCookies(res);
    res.status(401).json({
      error: 'Two-factor verification timed out. Please sign in again.',
      expired: true,
    });
    return null;
  }

  const liveRecord = store.getUserRecord(pending.userId);
  const liveHasFactor = hasPrimaryFactor(liveRecord);
  const liveMustEnroll = config.require2fa && !liveHasFactor;

  if (options.requireMustEnroll && !liveMustEnroll) {
    res.status(403).json({
      error: 'Enrollment is not permitted during two-factor verification.',
    });
    return null;
  }

  if (options.requireAlreadyEnrolled && !liveHasFactor) {
    res.status(400).json({
      error: 'No second factor is enrolled yet; complete enrollment first.',
    });
    return null;
  }

  if (pending.inFlight) {
    res.status(409).json({ error: 'Another verification request is already in progress.' });
    return null;
  }

  return pending;
}

/**
 * Responds with HTTP 429 + Retry-After header/JSON body when a user is temporarily locked out of
 * second-factor verification.
 */
function sendLockoutResponse(res: Response, retryAfter: number): void {
  res.setHeader('Retry-After', String(retryAfter));
  res.status(429).json({
    error: `Too many failed two-factor verification attempts. Try again in ${retryAfter} seconds.`,
    retryAfter,
  });
}

/**
 * Drops validation/note caches and terminates upstream Joplin Server sessions for sessions revoked
 * during first-factor enrollment.
 */
async function finalizeRevokedSessions(
  revokedTokens: string[],
  req: Request,
  store: TwoFactorStore
): Promise<void> {
  for (const token of revokedTokens) {
    invalidateSessionValidation(token, req.authState, store);
  }
  await Promise.all(revokedTokens.map((token) => endJoplinSessionSafe(token)));
}

/**
 * Records a failed verification attempt on a pending login. Drops the pending login and ends the
 * upstream Joplin session once max attempts are reached.
 */
async function failPendingAttempt(
  res: Response,
  store: TwoFactorStore,
  pending: PendingLogin,
  message: string
): Promise<void> {
  pending.attempts += 1;
  if (pending.attempts >= pending.maxAttempts) {
    store.deletePendingByHash(pending.tokenHash);
    await endJoplinSessionSafe(pending.joplinSessionId);
    clearPendingCookies(res);
    res.status(401).json({
      error: 'Too many failed verification attempts. Please sign in again.',
      expired: true,
      attemptsRemaining: 0,
    });
    return;
  }
  res.status(401).json({
    error: message,
    expired: false,
    attemptsRemaining: pending.maxAttempts - pending.attempts,
  });
}

type EnrollContext =
  | { mode: 'pending'; pending: PendingLogin; userId: string; email: string }
  | { mode: 'session'; sessionId: string; userId: string; email: string };

/**
 * Resolves either a full authenticated session (with step-up check when factors already exist) or
 * a live `mustEnroll` pending login for factor enrollment routes.
 */
async function resolveEnrollContext(
  req: Request,
  res: Response,
  config: AppConfig,
  store: TwoFactorStore
): Promise<EnrollContext | null> {
  const { token: sessionToken, duplicateCookies } = getSessionToken(req);
  if (duplicateCookies) {
    res.status(401).json({ error: 'Unauthorized: Conflicting session cookies. Please sign in again.' });
    return null;
  }

  if (sessionToken || getHeaderSessionToken(req)) {
    const ok = await authenticateSession(req, res);
    if (!ok) return null;
    const userId = req.userId!;
    const record = store.getUserRecord(userId);
    if (hasPrimaryFactor(record) && !isStepUpFresh(store, req.sessionId!).valid) {
      res.status(403).json({
        error: 'Please verify your identity with a second factor to make security changes.',
        stepUpRequired: true,
        methods: getEnrolledMethods(record),
      });
      return null;
    }
    return {
      mode: 'session',
      sessionId: req.sessionId!,
      userId,
      email: req.userEmail || userId,
    };
  }

  const pending = await loadPendingLogin(req, res, config, store, { requireMustEnroll: true });
  if (!pending) return null;
  return {
    mode: 'pending',
    pending,
    userId: pending.userId,
    email: pending.email,
  };
}

/**
 * Middleware for Settings write routes requiring a full authenticated session and fresh step-up
 * (within 5 minutes) whenever at least one primary factor is enrolled.
 */
async function requireStepUpSession(
  req: Request,
  res: Response,
  config: AppConfig,
  store: TwoFactorStore
): Promise<{ sessionId: string; userId: string; email: string } | null> {
  if (!config.cacheDir) {
    res.status(503).json({ error: 'Two-factor authentication requires CACHE_DIR to be configured on the server.' });
    return null;
  }
  const ok = await authenticateSession(req, res);
  if (!ok) return null;
  const userId = req.userId!;
  const record = store.getUserRecord(userId);
  if (hasPrimaryFactor(record) && !isStepUpFresh(store, req.sessionId!).valid) {
    res.status(403).json({
      error: 'Please verify your identity with a second factor to make security changes.',
      stepUpRequired: true,
      methods: getEnrolledMethods(record),
    });
    return null;
  }
  return {
    sessionId: req.sessionId!,
    userId,
    email: req.userEmail || userId,
  };
}

function getWebAuthnRpOrRespond(
  req: Request,
  res: Response,
  config: AppConfig
): { rpId: string; expectedOrigin: string } | null {
  const rp = resolveWebAuthnRp(config, req.headers.origin);
  if (!rp) {
    res.status(400).json({
      error:
        config.nodeEnv === 'production' && !config.publicUrl
          ? 'Passkeys require PUBLIC_URL to be configured on the server.'
          : 'Passkeys require PUBLIC_URL or an http://localhost origin.',
    });
    return null;
  }
  return rp;
}

/**
 * Builds the /api/auth/2fa router covering pending-login verification, forced/optional enrollment,
 * step-up checks, factor management, recovery codes, and trusted devices.
 */
export function createTwoFactorRouter(config: AppConfig, store: TwoFactorStore): Router {
  const router = Router();

  const requirePersistence = (_req: Request, res: Response, next: () => void) => {
    if (!config.cacheDir) {
      res.status(503).json({ error: 'Two-factor authentication requires CACHE_DIR to be configured on the server.' });
      return;
    }
    next();
  };

  /**
   * GET /api/auth/2fa/status
   * Current user's enrolled 2FA status and step-up validity (never exposes secrets or hashes).
   */
  router.get('/status', requireAuth, (req, res) => {
    if (!config.cacheDir || !req.userId) {
      res.status(200).json({
        persistenceEnabled: Boolean(config.cacheDir),
        require2fa: config.require2fa,
        passkeysAvailable: false,
        enrolled: { totp: false, passkeysCount: 0, recoveryCodesRemaining: 0 },
        methods: [],
        stepUpValid: false,
        stepUpExpiresAt: null,
      });
      return;
    }

    const record = store.getUserRecord(req.userId);
    const stepUp = isStepUpFresh(store, req.sessionId!);
    const recoveryCodesRemaining = record.recoveryCodes.filter((c) => c.usedAt === null).length;

    res.status(200).json({
      persistenceEnabled: true,
      require2fa: config.require2fa,
      passkeysAvailable: isWebAuthnConfigured(config),
      enrolled: {
        totp: Boolean(record.totp),
        passkeysCount: record.passkeys.length,
        recoveryCodesRemaining,
      },
      methods: getEnrolledMethods(record),
      stepUpValid: stepUp.valid,
      stepUpExpiresAt: stepUp.expiresAt,
    });
  });

  // ---------------------------------------------------------------------------
  // TOTP Setup & Confirmation (pending mustEnroll OR full session)
  // ---------------------------------------------------------------------------

  router.post('/totp/setup', requirePersistence, async (req, res) => {
    const ctx = await resolveEnrollContext(req, res, config, store);
    if (!ctx) return;

    const record = store.getUserRecord(ctx.userId);
    if (record.totp) {
      res.status(409).json({ error: 'Authenticator app is already configured. Remove it before setting up a new one.' });
      return;
    }

    const secret = generateTotpSecret();
    const otpauthUri = buildOtpauthUri(secret, ctx.email);
    const qrDataUrl = await generateQrSvgDataUrl(otpauthUri);

    if (ctx.mode === 'pending') {
      if (ctx.pending.consumed || !config.require2fa || hasPrimaryFactor(store.getUserRecord(ctx.userId))) {
        res.status(403).json({ error: 'Enrollment is not permitted during two-factor verification.' });
        return;
      }
      ctx.pending.pendingTotpSecret = secret;
    } else {
      store.setSessionTotpSetup(ctx.sessionId, secret);
    }

    res.status(200).json({ secret, otpauthUri, qrDataUrl });
  });

  router.post('/totp/confirm', requirePersistence, async (req, res) => {
    const ctx = await resolveEnrollContext(req, res, config, store);
    if (!ctx) return;

    const { code, trustDevice } = req.body ?? {};
    if (typeof code !== 'string' || !code.trim()) {
      res.status(400).json({ error: 'A 6-digit verification code is required.' });
      return;
    }

    if (ctx.mode === 'pending') ctx.pending.inFlight = true;
    try {
      const secret =
        ctx.mode === 'pending'
          ? ctx.pending.pendingTotpSecret
          : store.getSessionTotpSetup(ctx.sessionId);

      if (!secret) {
        res.status(400).json({ error: 'No pending authenticator setup found. Generate a new QR code and try again.' });
        return;
      }

      const check = verifyTotp(secret, code);
      if (!check.valid || check.step === null) {
        if (ctx.mode === 'pending') {
          await failPendingAttempt(res, store, ctx.pending, 'Invalid 6-digit code. Check your authenticator app and try again.');
        } else {
          res.status(400).json({ error: 'Invalid 6-digit code. Check your authenticator app and try again.' });
        }
        return;
      }

      const now = Date.now();

      const outcome = await store.withUserLock(ctx.userId, () => {
        const record = store.getUserRecord(ctx.userId);
        if (ctx.mode === 'pending' && (!config.require2fa || hasPrimaryFactor(record))) {
          return { status: 'already_enrolled' as const };
        }
        if (record.totp) {
          return { status: 'totp_exists' as const };
        }

        const isFirstFactor = !hasPrimaryFactor(record);
        let generatedRecoveryCodes: string[] | undefined;
        if (isFirstFactor) {
          const generated = generateRecoveryCodes();
          record.recoverySalt = generated.salt;
          record.recoveryCodes = generated.hashedCodes;
          record.trustedDevices = [];
          generatedRecoveryCodes = generated.plaintextCodes;
        }

        record.totp = {
          secret,
          createdAt: now,
          lastUsedStep: check.step,
        };
        store.saveUserRecord(record, now);

        const keepSessionId = ctx.mode === 'pending' ? ctx.pending.joplinSessionId : ctx.sessionId;
        const revokedTokens = isFirstFactor ? store.revokeOtherSessionsForUser(ctx.userId, keepSessionId) : [];

        return {
          status: 'ok' as const,
          isFirstFactor,
          recoveryCodes: generatedRecoveryCodes,
          revokedTokens,
        };
      });

      if (outcome.status === 'already_enrolled') {
        if (ctx.mode === 'pending') ctx.pending.pendingTotpSecret = null;
        res.status(403).json({ error: 'Enrollment is not permitted during two-factor verification.' });
        return;
      }
      if (outcome.status === 'totp_exists') {
        res.status(409).json({ error: 'Authenticator app is already configured.' });
        return;
      }

      await finalizeRevokedSessions(outcome.revokedTokens, req, store);

      if (ctx.mode === 'pending') {
        ctx.pending.pendingTotpSecret = null;
        if (outcome.isFirstFactor && !trustDevice) {
          clearTrustedDeviceCookies(res);
        }
        await promotePendingLogin(req, res, config, store, ctx.pending, { trustDevice: Boolean(trustDevice) });
        res.status(200).json({
          verified: true,
          userId: ctx.userId,
          recoveryCodes: outcome.recoveryCodes,
        });
      } else {
        store.clearSessionTotpSetup(ctx.sessionId);
        const stepUpExpiresAt = store.touchStepUp(ctx.sessionId, now);
        if (outcome.isFirstFactor) {
          clearTrustedDeviceCookies(res);
        }
        res.status(200).json({
          enrolled: true,
          stepUpExpiresAt,
          recoveryCodes: outcome.recoveryCodes,
        });
      }
    } finally {
      if (ctx.mode === 'pending') ctx.pending.inFlight = false;
    }
  });

  // ---------------------------------------------------------------------------
  // Passkey Registration (pending mustEnroll OR full session)
  // ---------------------------------------------------------------------------

  router.post('/passkey/register/options', requirePersistence, async (req, res) => {
    const ctx = await resolveEnrollContext(req, res, config, store);
    if (!ctx) return;

    const rp = getWebAuthnRpOrRespond(req, res, config);
    if (!rp) return;

    const record = store.getUserRecord(ctx.userId);
    const options = await generateRegistrationOptions({
      rpName: 'Joplin Web',
      rpID: rp.rpId,
      userName: ctx.email,
      userDisplayName: ctx.email,
      userID: userIdBytesForWebAuthn(ctx.userId),
      attestationType: 'none',
      excludeCredentials: record.passkeys.map((pk) => ({
        id: pk.credentialID,
        transports: pk.transports,
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });

    const challengeRecord = {
      challenge: options.challenge,
      expectedOrigin: rp.expectedOrigin,
      expectedRPID: rp.rpId,
      expiresAt: Date.now() + WEBAUTHN_CHALLENGE_TTL_MS,
      kind: 'register' as const,
    };

    if (ctx.mode === 'pending') {
      if (ctx.pending.consumed || !config.require2fa || hasPrimaryFactor(store.getUserRecord(ctx.userId))) {
        res.status(403).json({ error: 'Enrollment is not permitted during two-factor verification.' });
        return;
      }
      ctx.pending.webAuthnChallenge = challengeRecord;
    } else {
      store.setSessionWebAuthnChallenge(ctx.sessionId, challengeRecord);
    }

    res.status(200).json(options);
  });

  router.post('/passkey/register/verify', requirePersistence, async (req, res) => {
    const ctx = await resolveEnrollContext(req, res, config, store);
    if (!ctx) return;

    const { response, name, trustDevice } = req.body ?? {};
    if (!response || typeof response !== 'object') {
      res.status(400).json({ error: 'Invalid passkey registration response.' });
      return;
    }

    if (ctx.mode === 'pending') ctx.pending.inFlight = true;
    try {
      let challengeRecord = null;
      if (ctx.mode === 'pending') {
        const entry = ctx.pending.webAuthnChallenge;
        ctx.pending.webAuthnChallenge = null;
        if (entry && entry.kind === 'register' && entry.expiresAt > Date.now()) {
          challengeRecord = entry;
        }
      } else {
        challengeRecord = store.consumeSessionWebAuthnChallenge(ctx.sessionId, 'register');
      }

      if (!challengeRecord) {
        res.status(400).json({ error: 'Passkey registration challenge missing or expired. Please try again.' });
        return;
      }

      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response: response as RegistrationResponseJSON,
          expectedChallenge: challengeRecord.challenge,
          expectedOrigin: challengeRecord.expectedOrigin,
          expectedRPID: challengeRecord.expectedRPID,
          requireUserPresence: true,
          requireUserVerification: false,
        });
      } catch {
        if (ctx.mode === 'pending') {
          await failPendingAttempt(res, store, ctx.pending, 'Passkey registration could not be verified.');
        } else {
          res.status(400).json({ error: 'Passkey registration could not be verified.' });
        }
        return;
      }

      if (!verification.verified || !verification.registrationInfo) {
        if (ctx.mode === 'pending') {
          await failPendingAttempt(res, store, ctx.pending, 'Passkey registration could not be verified.');
        } else {
          res.status(400).json({ error: 'Passkey registration could not be verified.' });
        }
        return;
      }

      const { credential } = verification.registrationInfo;
      const now = Date.now();

      const result = await store.withUserLock(ctx.userId, () => {
        const record = store.getUserRecord(ctx.userId);
        if (ctx.mode === 'pending' && (!config.require2fa || hasPrimaryFactor(record))) {
          return { status: 'already_enrolled' as const };
        }
        if (record.passkeys.some((pk) => pk.credentialID === credential.id)) {
          return { status: 'duplicate' as const };
        }

        const isFirstFactor = !hasPrimaryFactor(record);
        let generatedRecoveryCodes: string[] | undefined;
        if (isFirstFactor) {
          const generated = generateRecoveryCodes();
          record.recoverySalt = generated.salt;
          record.recoveryCodes = generated.hashedCodes;
          record.trustedDevices = [];
          generatedRecoveryCodes = generated.plaintextCodes;
        }

        const passkeyName = sanitizePasskeyName(name, record.passkeys.length + 1);
        const rawTransports = credential.transports ?? (response as RegistrationResponseJSON).response?.transports;
        const transports = Array.isArray(rawTransports)
          ? rawTransports.filter((t): t is string => typeof t === 'string')
          : undefined;

        const saved = {
          credentialID: credential.id,
          publicKey: Buffer.from(credential.publicKey).toString('base64url'),
          counter: credential.counter,
          ...(transports && transports.length > 0 ? { transports } : {}),
          name: passkeyName,
          createdAt: now,
          lastUsedAt: null,
        };
        record.passkeys.push(saved);
        store.saveUserRecord(record, now);

        const keepSessionId = ctx.mode === 'pending' ? ctx.pending.joplinSessionId : ctx.sessionId;
        const revokedTokens = isFirstFactor ? store.revokeOtherSessionsForUser(ctx.userId, keepSessionId) : [];

        return {
          status: 'ok' as const,
          isFirstFactor,
          passkey: saved,
          recoveryCodes: generatedRecoveryCodes,
          revokedTokens,
        };
      });

      if (result.status === 'already_enrolled') {
        res.status(403).json({ error: 'Enrollment is not permitted during two-factor verification.' });
        return;
      }
      if (result.status === 'duplicate') {
        res.status(409).json({ error: 'This passkey is already registered.' });
        return;
      }

      await finalizeRevokedSessions(result.revokedTokens, req, store);

      if (ctx.mode === 'pending') {
        if (result.isFirstFactor && !trustDevice) {
          clearTrustedDeviceCookies(res);
        }
        await promotePendingLogin(req, res, config, store, ctx.pending, { trustDevice: Boolean(trustDevice) });
        res.status(200).json({
          verified: true,
          userId: ctx.userId,
          passkey: {
            id: result.passkey.credentialID,
            name: result.passkey.name,
            createdAt: result.passkey.createdAt,
            lastUsedAt: result.passkey.lastUsedAt,
          },
          recoveryCodes: result.recoveryCodes,
        });
      } else {
        const stepUpExpiresAt = store.touchStepUp(ctx.sessionId, now);
        if (result.isFirstFactor) {
          clearTrustedDeviceCookies(res);
        }
        res.status(200).json({
          enrolled: true,
          stepUpExpiresAt,
          passkey: {
            id: result.passkey.credentialID,
            name: result.passkey.name,
            createdAt: result.passkey.createdAt,
            lastUsedAt: result.passkey.lastUsedAt,
          },
          recoveryCodes: result.recoveryCodes,
        });
      }
    } finally {
      if (ctx.mode === 'pending') ctx.pending.inFlight = false;
    }
  });

  // ---------------------------------------------------------------------------
  // Pending-Login Second-Factor Verification (!mustEnroll)
  // ---------------------------------------------------------------------------

  router.post('/totp/verify', requirePersistence, async (req, res) => {
    const pending = await loadPendingLogin(req, res, config, store, { requireAlreadyEnrolled: true });
    if (!pending) return;

    const { code, trustDevice } = req.body ?? {};
    if (typeof code !== 'string' || !code.trim()) {
      res.status(400).json({ error: 'A 6-digit verification code is required.' });
      return;
    }

    pending.inFlight = true;
    try {
      const outcome = await store.withUserLock(pending.userId, () => {
        const now = Date.now();
        const record = store.getUserRecord(pending.userId);
        const lockedRetryAfter = getLockoutRetryAfterSeconds(record, now);
        if (lockedRetryAfter !== null) {
          return { status: 'locked' as const, retryAfter: lockedRetryAfter };
        }
        if (!record.totp) {
          recordFailedSecondFactor(record, now);
          store.saveUserRecord(record, now);
          return { status: 'failed' as const, reason: 'Authenticator app is not configured for this account.' };
        }
        const check = verifyTotp(record.totp.secret, code, { lastUsedStep: record.totp.lastUsedStep });
        if (!check.valid || check.step === null) {
          recordFailedSecondFactor(record, now);
          store.saveUserRecord(record, now);
          return { status: 'failed' as const, reason: 'Invalid verification code.' };
        }
        record.totp = { ...record.totp, lastUsedStep: check.step };
        clearFailedSecondFactor(record);
        store.saveUserRecord(record, now);
        return { status: 'ok' as const };
      });

      if (outcome.status === 'locked') {
        sendLockoutResponse(res, outcome.retryAfter);
        return;
      }
      if (outcome.status === 'failed') {
        await failPendingAttempt(res, store, pending, outcome.reason);
        return;
      }

      await promotePendingLogin(req, res, config, store, pending, { trustDevice: Boolean(trustDevice) });
      res.status(200).json({ verified: true, userId: pending.userId });
    } finally {
      pending.inFlight = false;
    }
  });

  router.post('/passkey/auth/options', requirePersistence, async (req, res) => {
    const pending = await loadPendingLogin(req, res, config, store, { requireAlreadyEnrolled: true });
    if (!pending) return;

    const rp = getWebAuthnRpOrRespond(req, res, config);
    if (!rp) return;

    const record = store.getUserRecord(pending.userId);
    if (record.passkeys.length === 0) {
      res.status(400).json({ error: 'No passkeys are registered for this account.' });
      return;
    }

    const options = await generateAuthenticationOptions({
      rpID: rp.rpId,
      allowCredentials: record.passkeys.map((pk) => ({
        id: pk.credentialID,
        transports: pk.transports,
      })),
      userVerification: 'preferred',
    });

    pending.webAuthnChallenge = {
      challenge: options.challenge,
      expectedOrigin: rp.expectedOrigin,
      expectedRPID: rp.rpId,
      expiresAt: Date.now() + WEBAUTHN_CHALLENGE_TTL_MS,
      kind: 'authenticate',
    };

    res.status(200).json(options);
  });

  router.post('/passkey/auth/verify', requirePersistence, async (req, res) => {
    const pending = await loadPendingLogin(req, res, config, store, { requireAlreadyEnrolled: true });
    if (!pending) return;

    const { response, trustDevice } = req.body ?? {};
    if (!response || typeof response !== 'object' || typeof (response as { id?: unknown }).id !== 'string') {
      res.status(400).json({ error: 'Invalid passkey assertion.' });
      return;
    }

    pending.inFlight = true;
    try {
      const authResponse = response as AuthenticationResponseJSON;
      const result = await store.withUserLock(pending.userId, async () => {
        const now = Date.now();
        const record = store.getUserRecord(pending.userId);
        // Passkeys can't be guessed, so they are never locked out: the owner keeps a way in even
        // while someone who knows the password keeps the guessable factors locked

        const challengeRecord = pending.webAuthnChallenge;
        pending.webAuthnChallenge = null;
        if (!challengeRecord || challengeRecord.kind !== 'authenticate' || challengeRecord.expiresAt <= now) {
          return {
            status: 'failed' as const,
            reason: 'Passkey challenge missing or expired. Please try again.',
          };
        }

        const idx = record.passkeys.findIndex((pk) => pk.credentialID === authResponse.id);
        if (idx === -1) {
          return { status: 'failed' as const, reason: 'Passkey verification failed.' };
        }
        const passkey = record.passkeys[idx];

        let verification;
        try {
          verification = await verifyAuthenticationResponse({
            response: authResponse,
            expectedChallenge: challengeRecord.challenge,
            expectedOrigin: challengeRecord.expectedOrigin,
            expectedRPID: challengeRecord.expectedRPID,
            credential: {
              id: passkey.credentialID,
              publicKey: new Uint8Array(Buffer.from(passkey.publicKey, 'base64url')),
              counter: passkey.counter,
              transports: passkey.transports,
            },
            requireUserVerification: false,
          });
        } catch {
          return { status: 'failed' as const, reason: 'Passkey verification failed.' };
        }

        if (!verification.verified) {
          return { status: 'failed' as const, reason: 'Passkey verification failed.' };
        }

        const newCounter = verification.authenticationInfo.newCounter;
        if ((passkey.counter > 0 || newCounter > 0) && newCounter <= passkey.counter) {
          return { status: 'failed' as const, reason: 'Passkey verification failed.' };
        }

        record.passkeys[idx] = {
          ...passkey,
          counter: newCounter,
          lastUsedAt: now,
        };
        clearFailedSecondFactor(record);
        store.saveUserRecord(record, now);
        return { status: 'ok' as const };
      });

      if (result.status === 'failed') {
        await failPendingAttempt(res, store, pending, result.reason);
        return;
      }

      await promotePendingLogin(req, res, config, store, pending, { trustDevice: Boolean(trustDevice) });
      res.status(200).json({ verified: true, userId: pending.userId });
    } finally {
      pending.inFlight = false;
    }
  });

  router.post('/recovery/verify', requirePersistence, async (req, res) => {
    const pending = await loadPendingLogin(req, res, config, store, { requireAlreadyEnrolled: true });
    if (!pending) return;

    const { code, trustDevice } = req.body ?? {};
    if (typeof code !== 'string' || !code.trim()) {
      res.status(400).json({ error: 'A recovery code is required.' });
      return;
    }

    pending.inFlight = true;
    try {
      const result = await store.withUserLock(pending.userId, () => {
        const now = Date.now();
        const record = store.getUserRecord(pending.userId);
        const lockedRetryAfter = getLockoutRetryAfterSeconds(record, now);
        if (lockedRetryAfter !== null) {
          return { status: 'locked' as const, retryAfter: lockedRetryAfter };
        }
        const outcome = store.verifyAndConsumeRecoveryCodeLocked(record, code, now);
        if (!outcome.valid) {
          recordFailedSecondFactor(record, now);
          store.saveUserRecord(record, now);
          return { status: 'failed' as const };
        }
        clearFailedSecondFactor(record);
        store.saveUserRecord(record, now);
        return { status: 'ok' as const, remaining: outcome.remaining };
      });

      if (result.status === 'locked') {
        sendLockoutResponse(res, result.retryAfter);
        return;
      }
      if (result.status === 'failed') {
        await failPendingAttempt(res, store, pending, 'Invalid or already used recovery code.');
        return;
      }

      await promotePendingLogin(req, res, config, store, pending, { trustDevice: Boolean(trustDevice) });
      res.status(200).json({
        verified: true,
        userId: pending.userId,
        recoveryCodesRemaining: result.remaining,
      });
    } finally {
      pending.inFlight = false;
    }
  });

  // ---------------------------------------------------------------------------
  // Step-Up Verification (full session, grants 5-min window for sensitive edits)
  // ---------------------------------------------------------------------------

  router.post('/step-up/totp', requirePersistence, requireAuth, async (req, res) => {
    const { code } = req.body ?? {};
    if (typeof code !== 'string' || !code.trim()) {
      res.status(400).json({ error: 'A 6-digit verification code is required.' });
      return;
    }

    const userId = req.userId!;
    const outcome = await store.withUserLock(userId, () => {
      const now = Date.now();
      const record = store.getUserRecord(userId);
      const lockedRetryAfter = getLockoutRetryAfterSeconds(record, now);
      if (lockedRetryAfter !== null) {
        return { status: 'locked' as const, retryAfter: lockedRetryAfter };
      }
      if (!record.totp) {
        recordFailedSecondFactor(record, now);
        store.saveUserRecord(record, now);
        return { status: 'failed' as const };
      }
      const check = verifyTotp(record.totp.secret, code, { lastUsedStep: record.totp.lastUsedStep });
      if (!check.valid || check.step === null) {
        recordFailedSecondFactor(record, now);
        store.saveUserRecord(record, now);
        return { status: 'failed' as const };
      }
      record.totp = { ...record.totp, lastUsedStep: check.step };
      clearFailedSecondFactor(record);
      store.saveUserRecord(record, now);
      return { status: 'ok' as const };
    });

    if (outcome.status === 'locked') {
      sendLockoutResponse(res, outcome.retryAfter);
      return;
    }
    if (outcome.status === 'failed') {
      res.status(400).json({ error: 'Invalid verification code.' });
      return;
    }

    const stepUpExpiresAt = store.touchStepUp(req.sessionId!);
    res.status(200).json({ verified: true, stepUpExpiresAt });
  });

  router.post('/step-up/passkey/options', requirePersistence, requireAuth, async (req, res) => {
    const rp = getWebAuthnRpOrRespond(req, res, config);
    if (!rp) return;

    const record = store.getUserRecord(req.userId!);
    if (record.passkeys.length === 0) {
      res.status(400).json({ error: 'No passkeys are registered for this account.' });
      return;
    }

    const options = await generateAuthenticationOptions({
      rpID: rp.rpId,
      allowCredentials: record.passkeys.map((pk) => ({
        id: pk.credentialID,
        transports: pk.transports,
      })),
      userVerification: 'preferred',
    });

    store.setSessionWebAuthnChallenge(req.sessionId!, {
      challenge: options.challenge,
      expectedOrigin: rp.expectedOrigin,
      expectedRPID: rp.rpId,
      expiresAt: Date.now() + WEBAUTHN_CHALLENGE_TTL_MS,
      kind: 'step-up',
    });

    res.status(200).json(options);
  });

  router.post('/step-up/passkey/verify', requirePersistence, requireAuth, async (req, res) => {
    const { response } = req.body ?? {};
    if (!response || typeof response !== 'object' || typeof (response as { id?: unknown }).id !== 'string') {
      res.status(400).json({ error: 'Invalid passkey assertion.' });
      return;
    }

    const authResponse = response as AuthenticationResponseJSON;
    const userId = req.userId!;
    const outcome = await store.withUserLock(userId, async () => {
      const now = Date.now();
      const record = store.getUserRecord(userId);
      // Passkeys can't be guessed, so they are never locked out: the owner keeps a way in even
      // while someone who knows the password keeps the guessable factors locked

      const challengeRecord = store.consumeSessionWebAuthnChallenge(req.sessionId!, 'step-up', now);
      if (!challengeRecord) {
        return { status: 'no_challenge' as const };
      }

      const idx = record.passkeys.findIndex((pk) => pk.credentialID === authResponse.id);
      if (idx === -1) {
        return { status: 'failed' as const };
      }
      const passkey = record.passkeys[idx];

      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response: authResponse,
          expectedChallenge: challengeRecord.challenge,
          expectedOrigin: challengeRecord.expectedOrigin,
          expectedRPID: challengeRecord.expectedRPID,
          credential: {
            id: passkey.credentialID,
            publicKey: new Uint8Array(Buffer.from(passkey.publicKey, 'base64url')),
            counter: passkey.counter,
            transports: passkey.transports,
          },
          requireUserVerification: false,
        });
      } catch {
        return { status: 'failed' as const };
      }

      if (!verification.verified) {
        return { status: 'failed' as const };
      }

      const newCounter = verification.authenticationInfo.newCounter;
      if ((passkey.counter > 0 || newCounter > 0) && newCounter <= passkey.counter) {
        return { status: 'failed' as const };
      }

      record.passkeys[idx] = { ...passkey, counter: newCounter, lastUsedAt: now };
      clearFailedSecondFactor(record);
      store.saveUserRecord(record, now);
      return { status: 'ok' as const };
    });

    if (outcome.status === 'no_challenge') {
      res.status(400).json({ error: 'Passkey challenge missing or expired. Please try again.' });
      return;
    }
    if (outcome.status === 'failed') {
      res.status(400).json({ error: 'Passkey verification failed.' });
      return;
    }

    const stepUpExpiresAt = store.touchStepUp(req.sessionId!);
    res.status(200).json({ verified: true, stepUpExpiresAt });
  });

  router.post('/step-up/recovery', requirePersistence, requireAuth, async (req, res) => {
    const { code } = req.body ?? {};
    if (typeof code !== 'string' || !code.trim()) {
      res.status(400).json({ error: 'A recovery code is required.' });
      return;
    }

    const outcome = await store.withUserLock(req.userId!, () => {
      const now = Date.now();
      const record = store.getUserRecord(req.userId!);
      const lockedRetryAfter = getLockoutRetryAfterSeconds(record, now);
      if (lockedRetryAfter !== null) {
        return { status: 'locked' as const, retryAfter: lockedRetryAfter };
      }
      const check = store.verifyAndConsumeRecoveryCodeLocked(record, code, now);
      if (!check.valid) {
        recordFailedSecondFactor(record, now);
        store.saveUserRecord(record, now);
        return { status: 'failed' as const };
      }
      clearFailedSecondFactor(record);
      store.saveUserRecord(record, now);
      return { status: 'ok' as const, remaining: check.remaining };
    });

    if (outcome.status === 'locked') {
      sendLockoutResponse(res, outcome.retryAfter);
      return;
    }
    if (outcome.status === 'failed') {
      res.status(400).json({ error: 'Invalid or already used recovery code.' });
      return;
    }

    const stepUpExpiresAt = store.touchStepUp(req.sessionId!);
    res.status(200).json({
      verified: true,
      stepUpExpiresAt,
      recoveryCodesRemaining: outcome.remaining,
    });
  });

  // ---------------------------------------------------------------------------
  // Settings Factor Management (full session; mutations require step-up)
  // ---------------------------------------------------------------------------

  router.delete('/totp', async (req, res) => {
    const ctx = await requireStepUpSession(req, res, config, store);
    if (!ctx) return;

    let clearedAllFactors = false;
    const outcome = await store.withUserLock(ctx.userId, () => {
      const record = store.getUserRecord(ctx.userId);
      if (!record.totp) return 'not_found' as const;
      if (config.require2fa && record.passkeys.length === 0) {
        return 'last_factor_required' as const;
      }
      record.totp = null;
      if (!hasPrimaryFactor(record)) {
        record.recoverySalt = null;
        record.recoveryCodes = [];
        record.trustedDevices = [];
        clearedAllFactors = true;
      }
      store.saveUserRecord(record);
      return 'removed' as const;
    });

    if (outcome === 'not_found') {
      res.status(404).json({ error: 'Authenticator app is not configured.' });
      return;
    }
    if (outcome === 'last_factor_required') {
      res.status(400).json({
        error: 'Cannot remove your last two-factor method while REQUIRE_2FA is enabled. Add a passkey first.',
      });
      return;
    }

    if (clearedAllFactors) clearTrustedDeviceCookies(res);
    res.status(200).json({ removed: true });
  });

  router.get('/passkeys', requirePersistence, requireAuth, (req, res) => {
    const record = store.getUserRecord(req.userId!);
    res.status(200).json({
      passkeys: record.passkeys.map((pk) => ({
        id: pk.credentialID,
        name: pk.name,
        createdAt: pk.createdAt,
        lastUsedAt: pk.lastUsedAt,
      })),
    });
  });

  router.put('/passkeys/:id', async (req, res) => {
    const ctx = await requireStepUpSession(req, res, config, store);
    if (!ctx) return;

    const rawName = (req.body ?? {}).name;
    if (typeof rawName !== 'string' || !rawName.trim()) {
      res.status(400).json({ error: 'Passkey name is required.' });
      return;
    }
    const cleanName = rawName.trim().slice(0, 64);

    const updated = await store.withUserLock(ctx.userId, () => {
      const record = store.getUserRecord(ctx.userId);
      const idx = record.passkeys.findIndex((pk) => pk.credentialID === req.params.id);
      if (idx === -1) return null;
      record.passkeys[idx] = { ...record.passkeys[idx], name: cleanName };
      store.saveUserRecord(record);
      return {
        id: record.passkeys[idx].credentialID,
        name: record.passkeys[idx].name,
        createdAt: record.passkeys[idx].createdAt,
        lastUsedAt: record.passkeys[idx].lastUsedAt,
      };
    });

    if (!updated) {
      res.status(404).json({ error: 'Passkey not found.' });
      return;
    }

    res.status(200).json({ passkey: updated });
  });

  router.delete('/passkeys/:id', async (req, res) => {
    const ctx = await requireStepUpSession(req, res, config, store);
    if (!ctx) return;

    let clearedAllFactors = false;
    const outcome = await store.withUserLock(ctx.userId, () => {
      const record = store.getUserRecord(ctx.userId);
      const idx = record.passkeys.findIndex((pk) => pk.credentialID === req.params.id);
      if (idx === -1) return 'not_found' as const;

      const remainingPasskeys = record.passkeys.length - 1;
      if (config.require2fa && !record.totp && remainingPasskeys === 0) {
        return 'last_factor_required' as const;
      }

      record.passkeys.splice(idx, 1);
      if (!hasPrimaryFactor(record)) {
        record.recoverySalt = null;
        record.recoveryCodes = [];
        record.trustedDevices = [];
        clearedAllFactors = true;
      }
      store.saveUserRecord(record);
      return 'removed' as const;
    });

    if (outcome === 'not_found') {
      res.status(404).json({ error: 'Passkey not found.' });
      return;
    }
    if (outcome === 'last_factor_required') {
      res.status(400).json({
        error: 'Cannot remove your last two-factor method while REQUIRE_2FA is enabled. Set up another factor first.',
      });
      return;
    }

    if (clearedAllFactors) clearTrustedDeviceCookies(res);
    res.status(200).json({ removed: true });
  });

  router.post('/recovery/regenerate', async (req, res) => {
    const ctx = await requireStepUpSession(req, res, config, store);
    if (!ctx) return;

    const codes = await store.withUserLock(ctx.userId, () => {
      const record = store.getUserRecord(ctx.userId);
      if (!hasPrimaryFactor(record)) return null;
      const generated = generateRecoveryCodes();
      record.recoverySalt = generated.salt;
      record.recoveryCodes = generated.hashedCodes;
      store.saveUserRecord(record);
      return generated.plaintextCodes;
    });

    if (!codes) {
      res.status(400).json({ error: 'Enroll an authenticator app or passkey before generating recovery codes.' });
      return;
    }

    res.status(200).json({ recoveryCodes: codes });
  });

  router.get('/trusted-devices', requirePersistence, requireAuth, (req, res) => {
    const now = Date.now();
    const record = store.getUserRecord(req.userId!);
    const { token: tdToken, duplicateCookies } = getTrustedDeviceToken(req);
    const currentId = duplicateCookies ? null : store.findMatchingTrustedDeviceId(record, tdToken);

    const devices = record.trustedDevices
      .filter((d) => d.expiresAt > now)
      .map((d) => ({
        id: d.id,
        label: d.label,
        createdAt: d.createdAt,
        lastUsedAt: d.lastUsedAt,
        expiresAt: d.expiresAt,
        current: d.id === currentId,
      }));

    res.status(200).json({ devices });
  });

  router.delete('/trusted-devices', async (req, res) => {
    const ctx = await requireStepUpSession(req, res, config, store);
    if (!ctx) return;

    await store.withUserLock(ctx.userId, () => {
      const record = store.getUserRecord(ctx.userId);
      if (record.trustedDevices.length > 0) {
        record.trustedDevices = [];
        store.saveUserRecord(record);
      }
    });

    clearTrustedDeviceCookies(res);
    res.status(200).json({ revokedAll: true });
  });

  router.delete('/trusted-devices/:id', async (req, res) => {
    const ctx = await requireStepUpSession(req, res, config, store);
    if (!ctx) return;

    const { token: tdToken, duplicateCookies } = getTrustedDeviceToken(req);
    let wasCurrent = false;

    const found = await store.withUserLock(ctx.userId, () => {
      const record = store.getUserRecord(ctx.userId);
      const currentId = duplicateCookies ? null : store.findMatchingTrustedDeviceId(record, tdToken);
      const idx = record.trustedDevices.findIndex((d) => d.id === req.params.id);
      if (idx === -1) return false;
      wasCurrent = record.trustedDevices[idx].id === currentId;
      record.trustedDevices.splice(idx, 1);
      store.saveUserRecord(record);
      return true;
    });

    if (!found) {
      res.status(404).json({ error: 'Trusted device not found.' });
      return;
    }

    if (wasCurrent) clearTrustedDeviceCookies(res);
    res.status(200).json({ removed: true });
  });

  return router;
}
