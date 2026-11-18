import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodeBase32 } from './totp.js';

export const PENDING_LOGIN_TTL_MS = 5 * 60 * 1000;
export const PENDING_LOGIN_MAX_ATTEMPTS = 5;
export const STEP_UP_TTL_MS = 5 * 60 * 1000;
export const TRUSTED_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SETUP_TTL_MS = 10 * 60 * 1000;
export const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const RECOVERY_CODE_COUNT = 10;

const MAX_PENDING_LOGINS = 1000;
const MAX_TRUSTED_DEVICES = 50;
const SESSIONS_FILE = 'sessions.json';

export type TwoFactorMethod = 'passkey' | 'totp' | 'recovery';

export interface StoredPasskey {
  credentialID: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface StoredTotp {
  secret: string;
  createdAt: number;
  lastUsedStep: number | null;
}

export interface StoredRecoveryCode {
  hash: string;
  usedAt: number | null;
}

export interface StoredTrustedDevice {
  id: string;
  tokenHash: string;
  label: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
}

export interface UserTwoFactorRecord {
  version: 1;
  userId: string;
  totp: StoredTotp | null;
  passkeys: StoredPasskey[];
  recoverySalt: string | null;
  recoveryCodes: StoredRecoveryCode[];
  trustedDevices: StoredTrustedDevice[];
}

export interface WebAuthnChallengeRecord {
  challenge: string;
  expectedOrigin: string;
  expectedRPID: string;
  expiresAt: number;
  kind: 'register' | 'authenticate' | 'step-up';
}

export interface PendingLogin {
  tokenHash: string;
  joplinSessionId: string;
  userId: string;
  email: string;
  mustEnroll: boolean;
  methods: TwoFactorMethod[];
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
  inFlight: boolean;
  pendingTotpSecret: string | null;
  webAuthnChallenge: WebAuthnChallengeRecord | null;
}

export interface SessionRecord {
  userId: string;
  email?: string;
  createdAt: number;
  twoFactorPassed: boolean;
  lastSecondFactorAt: number | null;
  lastAccessedAt: number;
}

/**
 * Hashes a bearer/cookie token with SHA-256 so raw tokens are never stored on disk.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Derives the filesystem-safe ownerKey for a Joplin user id.
 * Uses the userId directly when it consists solely of safe filename characters; otherwise SHA-256.
 */
export function ownerKeyForUser(userId: string): string {
  if (!userId) throw new Error('userId is required');
  if (/^[A-Za-z0-9_-]{1,128}$/.test(userId)) return userId;
  return createHash('sha256').update(userId).digest('hex');
}

function emptyUserRecord(userId: string): UserTwoFactorRecord {
  return {
    version: 1,
    userId,
    totp: null,
    passkeys: [],
    recoverySalt: null,
    recoveryCodes: [],
    trustedDevices: [],
  };
}

function authDirPath(cacheDir: string): string {
  return path.resolve(cacheDir, 'auth');
}

function userFilePath(cacheDir: string, userId: string): string {
  const dir = authDirPath(cacheDir);
  const ownerKey = ownerKeyForUser(userId);
  const resolved = path.resolve(dir, `${ownerKey}.json`);
  if (path.dirname(resolved) !== dir) {
    throw new Error('Invalid ownerKey path');
  }
  return resolved;
}

/**
 * Atomically writes a JSON file with mode 0600 (temp file in same directory + chmod + rename).
 */
export function atomicWriteJson(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(value, null, 2), { mode: 0o600 });
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

function normalizeRecoveryCode(code: string): string {
  return code.trim().replace(/[-\s]/g, '').toUpperCase();
}

function hashRecoveryCode(salt: string, normalizedCode: string): string {
  return createHash('sha256').update(`${salt}:${normalizedCode}`).digest('hex');
}

/**
 * Generates 10 high-entropy recovery codes (80 bits each, formatted XXXX-XXXX-XXXX-XXXX)
 * along with a random per-user salt and salted SHA-256 hashes.
 */
export function generateRecoveryCodes(): {
  plaintextCodes: string[];
  salt: string;
  hashedCodes: StoredRecoveryCode[];
} {
  const salt = randomBytes(16).toString('hex');
  const plaintextCodes: string[] = [];
  const hashedCodes: StoredRecoveryCode[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const raw = encodeBase32(randomBytes(10)); // 16 Base32 chars = 80 bits
    const formatted = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
    plaintextCodes.push(formatted);
    hashedCodes.push({ hash: hashRecoveryCode(salt, raw), usedAt: null });
  }
  return { plaintextCodes, salt, hashedCodes };
}

/**
 * Summarizes a User-Agent header into a concise non-sensitive device label.
 */
export function summarizeUserAgent(userAgent: string | undefined): string {
  if (!userAgent) return 'Unknown device';
  const ua = userAgent.slice(0, 512);
  let browser = 'Browser';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Chrome\//i.test(ua) && !/Chromium\//i.test(ua)) browser = 'Chrome';
  else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) browser = 'Safari';

  let os = '';
  if (/iPhone|iPad/i.test(ua)) os = 'iOS';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Linux/i.test(ua)) os = 'Linux';

  return os ? `${browser} on ${os}` : browser;
}

/**
 * Lists the enrolled authentication methods available for a user record.
 */
export function getEnrolledMethods(record: UserTwoFactorRecord): TwoFactorMethod[] {
  const methods: TwoFactorMethod[] = [];
  if (record.passkeys.length > 0) methods.push('passkey');
  if (record.totp) methods.push('totp');
  if (record.recoveryCodes.some((c) => c.usedAt === null)) methods.push('recovery');
  return methods;
}

/**
 * Whether the user has at least one primary 2FA factor (TOTP or passkey) enrolled.
 */
export function hasPrimaryFactor(record: UserTwoFactorRecord): boolean {
  return Boolean(record.totp) || record.passkeys.length > 0;
}

function validateUserRecord(raw: unknown, expectedUserId: string): UserTwoFactorRecord {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid 2FA record: expected object');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1 || typeof obj.userId !== 'string' || obj.userId !== expectedUserId) {
    throw new Error('Invalid 2FA record version or userId');
  }
  if (!Array.isArray(obj.passkeys) || !Array.isArray(obj.recoveryCodes) || !Array.isArray(obj.trustedDevices)) {
    throw new Error('Invalid 2FA record lists');
  }
  return {
    version: 1,
    userId: obj.userId,
    totp: (obj.totp as StoredTotp | null) ?? null,
    passkeys: obj.passkeys as StoredPasskey[],
    recoverySalt: (obj.recoverySalt as string | null) ?? null,
    recoveryCodes: obj.recoveryCodes as StoredRecoveryCode[],
    trustedDevices: obj.trustedDevices as StoredTrustedDevice[],
  };
}

/**
 * Manages persistent 2FA enrollments, session bindings, pending logins, and ephemeral challenges.
 */
export class TwoFactorStore {
  private readonly cacheDir: string | null;
  private readonly userLocks = new Map<string, Promise<unknown>>();
  private readonly pendingLogins = new Map<string, PendingLogin>();
  private readonly inMemorySessions = new Map<string, SessionRecord>();
  private readonly pendingTotpSetups = new Map<string, { secret: string; expiresAt: number }>();
  private readonly sessionChallenges = new Map<string, WebAuthnChallengeRecord>();

  /** Called after every recorded (fully signed-in) session, e.g. to share the user's note cache */
  private readonly onSessionRecorded?: (sessionId: string, userId: string) => void;

  constructor(cacheDir: string | null, onSessionRecorded?: (sessionId: string, userId: string) => void) {
    this.cacheDir = cacheDir;
    this.onSessionRecorded = onSessionRecorded;
  }

  /**
   * Ensures `CACHE_DIR/auth` exists with mode 0700 when persistence is configured.
   */
  public ensureAuthDir(): void {
    if (!this.cacheDir) return;
    const dir = authDirPath(this.cacheDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }

  /**
   * Serializes read-modify-write sequences for a single user so concurrent requests cannot race.
   */
  public async withUserLock<T>(userId: string, fn: () => Promise<T> | T): Promise<T> {
    const key = ownerKeyForUser(userId);
    const prev = this.userLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = prev.then(() => gate);
    this.userLocks.set(key, chain);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.userLocks.get(key) === chain) {
        this.userLocks.delete(key);
      }
    }
  }

  /**
   * Reads a user's 2FA record from disk. Returns an empty record if the file does not exist;
   * throws (fails closed) if the file exists but is unreadable or malformed.
   */
  public getUserRecord(userId: string): UserTwoFactorRecord {
    if (!this.cacheDir) return emptyUserRecord(userId);
    const filePath = userFilePath(this.cacheDir, userId);
    let text: string;
    try {
      text = readFileSync(filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return emptyUserRecord(userId);
      }
      throw err;
    }
    const parsed = JSON.parse(text) as unknown;
    return validateUserRecord(parsed, userId);
  }

  /**
   * Persists a user's 2FA record atomically with mode 0600, pruning expired trusted devices.
   */
  public saveUserRecord(record: UserTwoFactorRecord, now = Date.now()): void {
    if (!this.cacheDir) {
      throw new Error('CACHE_DIR must be configured to persist two-factor authentication state');
    }
    const pruned: UserTwoFactorRecord = {
      ...record,
      trustedDevices: record.trustedDevices
        .filter((d) => d.expiresAt > now)
        .slice(-MAX_TRUSTED_DEVICES),
    };
    atomicWriteJson(userFilePath(this.cacheDir, record.userId), pruned);
  }

  /**
   * Verifies and consumes a single-use recovery code for the given user.
   */
  public async verifyAndConsumeRecoveryCode(
    userId: string,
    inputCode: string
  ): Promise<{ valid: boolean; remaining: number }> {
    return this.withUserLock(userId, () => {
      const record = this.getUserRecord(userId);
      if (!record.recoverySalt || record.recoveryCodes.length === 0) {
        return { valid: false, remaining: 0 };
      }
      const normalized = normalizeRecoveryCode(inputCode);
      if (!/^[A-Z2-7]{16}$/.test(normalized)) {
        const remaining = record.recoveryCodes.filter((c) => c.usedAt === null).length;
        return { valid: false, remaining };
      }
      const candidateBuf = Buffer.from(hashRecoveryCode(record.recoverySalt, normalized), 'hex');
      let matchedIndex = -1;
      for (let i = 0; i < record.recoveryCodes.length; i++) {
        const entry = record.recoveryCodes[i];
        if (entry.usedAt !== null) continue;
        const storedBuf = Buffer.from(entry.hash, 'hex');
        if (storedBuf.length === candidateBuf.length && timingSafeEqual(storedBuf, candidateBuf)) {
          matchedIndex = i;
        }
      }
      if (matchedIndex === -1) {
        const remaining = record.recoveryCodes.filter((c) => c.usedAt === null).length;
        return { valid: false, remaining };
      }
      record.recoveryCodes[matchedIndex] = {
        ...record.recoveryCodes[matchedIndex],
        usedAt: Date.now(),
      };
      this.saveUserRecord(record);
      const remaining = record.recoveryCodes.filter((c) => c.usedAt === null).length;
      return { valid: true, remaining };
    });
  }

  /**
   * Creates and persists a new 30-day trusted device token for the user.
   */
  public async createTrustedDevice(
    userId: string,
    userAgent: string | undefined,
    now = Date.now()
  ): Promise<{ token: string; device: StoredTrustedDevice }> {
    return this.withUserLock(userId, () => {
      const record = this.getUserRecord(userId);
      const token = randomBytes(32).toString('base64url');
      const device: StoredTrustedDevice = {
        id: randomBytes(16).toString('hex'),
        tokenHash: hashToken(token),
        label: summarizeUserAgent(userAgent),
        createdAt: now,
        lastUsedAt: now,
        expiresAt: now + TRUSTED_DEVICE_TTL_MS,
      };
      record.trustedDevices = [...record.trustedDevices.filter((d) => d.expiresAt > now), device].slice(
        -MAX_TRUSTED_DEVICES
      );
      this.saveUserRecord(record, now);
      return { token, device };
    });
  }

  /**
   * Checks whether a trusted-device cookie token is valid and non-expired for the user.
   * Updates lastUsedAt on match.
   */
  public async verifyTrustedDevice(
    userId: string,
    token: string,
    now = Date.now()
  ): Promise<string | null> {
    if (!token || token.length > 256) return null;
    return this.withUserLock(userId, () => {
      const record = this.getUserRecord(userId);
      if (record.trustedDevices.length === 0) return null;

      const candidateBuf = Buffer.from(hashToken(token), 'hex');
      const active = record.trustedDevices.filter((d) => d.expiresAt > now);
      const prunedExpired = active.length !== record.trustedDevices.length;

      let matchedIndex = -1;
      for (let i = 0; i < active.length; i++) {
        const storedBuf = Buffer.from(active[i].tokenHash, 'hex');
        if (storedBuf.length === candidateBuf.length && timingSafeEqual(storedBuf, candidateBuf)) {
          matchedIndex = i;
        }
      }

      if (matchedIndex === -1) {
        if (prunedExpired) {
          record.trustedDevices = active;
          this.saveUserRecord(record, now);
        }
        return null;
      }

      active[matchedIndex] = { ...active[matchedIndex], lastUsedAt: now };
      record.trustedDevices = active;
      this.saveUserRecord(record, now);
      return active[matchedIndex].id;
    });
  }

  /**
   * Finds which trusted device id matches the provided cookie token without mutating state.
   */
  public findMatchingTrustedDeviceId(record: UserTwoFactorRecord, token: string | undefined): string | null {
    if (!token || record.trustedDevices.length === 0) return null;
    const now = Date.now();
    const candidateBuf = Buffer.from(hashToken(token), 'hex');
    let matchedId: string | null = null;
    for (const device of record.trustedDevices) {
      if (device.expiresAt <= now) continue;
      const storedBuf = Buffer.from(device.tokenHash, 'hex');
      if (storedBuf.length === candidateBuf.length && timingSafeEqual(storedBuf, candidateBuf)) {
        matchedId = device.id;
      }
    }
    return matchedId;
  }

  // ---------------------------------------------------------------------------
  // Pending Login Management (5 min TTL, 5 attempts max, single use)
  // ---------------------------------------------------------------------------

  /**
   * Creates a pending login holding the Joplin Server session server-side until 2FA completes.
   * Returns the raw pending token to set in the httpOnly pending cookie, plus any evicted
   * Joplin session ids that callers should end upstream.
   */
  public createPendingLogin(input: {
    joplinSessionId: string;
    userId: string;
    email: string;
    mustEnroll: boolean;
    methods: TwoFactorMethod[];
    now?: number;
  }): { token: string; pending: PendingLogin; evictedSessions: string[] } {
    const now = input.now ?? Date.now();
    const evictedSessions = this.pruneExpiredPendingLogins(now);

    while (this.pendingLogins.size >= MAX_PENDING_LOGINS) {
      const oldestKey = this.pendingLogins.keys().next().value;
      if (!oldestKey) break;
      const evicted = this.pendingLogins.get(oldestKey);
      this.pendingLogins.delete(oldestKey);
      if (evicted && !evicted.consumed) evictedSessions.push(evicted.joplinSessionId);
    }

    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const pending: PendingLogin = {
      tokenHash,
      joplinSessionId: input.joplinSessionId,
      userId: input.userId,
      email: input.email,
      mustEnroll: input.mustEnroll,
      methods: input.methods,
      attempts: 0,
      maxAttempts: PENDING_LOGIN_MAX_ATTEMPTS,
      createdAt: now,
      expiresAt: now + PENDING_LOGIN_TTL_MS,
      consumed: false,
      inFlight: false,
      pendingTotpSecret: null,
      webAuthnChallenge: null,
    };
    this.pendingLogins.set(tokenHash, pending);
    return { token, pending, evictedSessions };
  }

  public getPendingLogin(rawToken: string): PendingLogin | null {
    if (!rawToken || rawToken.length > 256) return null;
    return this.pendingLogins.get(hashToken(rawToken)) ?? null;
  }

  public deletePendingLogin(rawToken: string): PendingLogin | null {
    if (!rawToken) return null;
    const key = hashToken(rawToken);
    const existing = this.pendingLogins.get(key) ?? null;
    if (existing) {
      existing.consumed = true;
      this.pendingLogins.delete(key);
    }
    return existing;
  }

  public deletePendingByHash(tokenHash: string): void {
    const existing = this.pendingLogins.get(tokenHash);
    if (existing) {
      existing.consumed = true;
      this.pendingLogins.delete(tokenHash);
    }
  }

  public pruneExpiredPendingLogins(now = Date.now()): string[] {
    const expiredSessions: string[] = [];
    for (const [key, entry] of this.pendingLogins) {
      if (entry.expiresAt <= now) {
        this.pendingLogins.delete(key);
        if (!entry.consumed) expiredSessions.push(entry.joplinSessionId);
      }
    }
    return expiredSessions;
  }

  // ---------------------------------------------------------------------------
  // Session Registry (persisted under CACHE_DIR/auth/sessions.json)
  // ---------------------------------------------------------------------------

  private sessionsFilePath(): string | null {
    return this.cacheDir ? path.join(authDirPath(this.cacheDir), SESSIONS_FILE) : null;
  }

  private loadSessionsMap(): Record<string, SessionRecord> {
    const filePath = this.sessionsFilePath();
    if (!filePath) return Object.fromEntries(this.inMemorySessions);
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, SessionRecord>;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.error('[TwoFactorStore] Failed to read sessions registry:', err);
      }
    }
    return {};
  }

  private saveSessionsMap(sessions: Record<string, SessionRecord>, now = Date.now()): void {
    const filePath = this.sessionsFilePath();
    if (!filePath) return;
    const pruned: Record<string, SessionRecord> = {};
    for (const [hash, rec] of Object.entries(sessions)) {
      if (rec && typeof rec.userId === 'string' && now - rec.lastAccessedAt <= TRUSTED_DEVICE_TTL_MS) {
        pruned[hash] = rec;
      }
    }
    atomicWriteJson(filePath, pruned);
  }

  /**
   * Records a full Joplin Web session (after login or 2FA promotion).
   */
  public recordSession(
    sessionId: string,
    info: { userId: string; email?: string; twoFactorPassed: boolean; lastSecondFactorAt: number | null },
    now = Date.now()
  ): void {
    const sessionHash = hashToken(sessionId);
    const record: SessionRecord = {
      userId: info.userId,
      email: info.email,
      createdAt: now,
      twoFactorPassed: info.twoFactorPassed,
      lastSecondFactorAt: info.lastSecondFactorAt,
      lastAccessedAt: now,
    };
    this.inMemorySessions.set(sessionHash, record);
    if (this.cacheDir) {
      const map = this.loadSessionsMap();
      map[sessionHash] = record;
      this.saveSessionsMap(map, now);
    }
    this.onSessionRecorded?.(sessionId, info.userId);
  }

  /**
   * Retrieves a recorded session by raw Joplin sessionId.
   */
  public getSession(sessionId: string): SessionRecord | null {
    const sessionHash = hashToken(sessionId);
    if (this.cacheDir) {
      const map = this.loadSessionsMap();
      const diskRecord = map[sessionHash];
      if (diskRecord) {
        this.inMemorySessions.set(sessionHash, diskRecord);
        return diskRecord;
      }
      this.inMemorySessions.delete(sessionHash);
      return null;
    }
    return this.inMemorySessions.get(sessionHash) ?? null;
  }

  /**
   * Updates the lastSecondFactorAt timestamp for step-up authentication (and marks twoFactorPassed).
   */
  public touchStepUp(sessionId: string, now = Date.now()): number {
    const sessionHash = hashToken(sessionId);
    if (this.cacheDir) {
      const map = this.loadSessionsMap();
      const existing = map[sessionHash] ?? this.inMemorySessions.get(sessionHash);
      if (existing) {
        const updated = { ...existing, twoFactorPassed: true, lastSecondFactorAt: now, lastAccessedAt: now };
        map[sessionHash] = updated;
        this.inMemorySessions.set(sessionHash, updated);
        this.saveSessionsMap(map, now);
      }
    } else {
      const existing = this.inMemorySessions.get(sessionHash);
      if (existing) {
        existing.twoFactorPassed = true;
        existing.lastSecondFactorAt = now;
        existing.lastAccessedAt = now;
      }
    }
    return now + STEP_UP_TTL_MS;
  }

  /**
   * Drops a session from the registry and clears its ephemeral setup/challenge state.
   */
  public removeSession(sessionId: string): void {
    const sessionHash = hashToken(sessionId);
    this.inMemorySessions.delete(sessionHash);
    this.pendingTotpSetups.delete(sessionHash);
    this.sessionChallenges.delete(sessionHash);
    if (this.cacheDir) {
      const map = this.loadSessionsMap();
      if (sessionHash in map) {
        delete map[sessionHash];
        this.saveSessionsMap(map);
      }
    }
  }

  /**
   * Drops other sessions for `userId` that never passed 2FA (called when enrolling the first factor).
   */
  public revokeUnverifiedSessionsForUser(userId: string, keepSessionId: string): void {
    const keepHash = hashToken(keepSessionId);
    for (const [hash, rec] of this.inMemorySessions) {
      if (hash !== keepHash && rec.userId === userId && !rec.twoFactorPassed) {
        this.inMemorySessions.delete(hash);
      }
    }
    if (this.cacheDir) {
      const map = this.loadSessionsMap();
      let changed = false;
      for (const [hash, rec] of Object.entries(map)) {
        if (hash !== keepHash && rec.userId === userId && !rec.twoFactorPassed) {
          delete map[hash];
          changed = true;
        }
      }
      if (changed) this.saveSessionsMap(map);
    }
  }

  // ---------------------------------------------------------------------------
  // Ephemeral Full-Session TOTP Setup & WebAuthn Challenges
  // ---------------------------------------------------------------------------

  public setSessionTotpSetup(sessionId: string, secret: string, now = Date.now()): void {
    const key = hashToken(sessionId);
    this.pendingTotpSetups.set(key, { secret, expiresAt: now + SETUP_TTL_MS });
  }

  public getSessionTotpSetup(sessionId: string, now = Date.now()): string | null {
    const key = hashToken(sessionId);
    const entry = this.pendingTotpSetups.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
      this.pendingTotpSetups.delete(key);
      return null;
    }
    return entry.secret;
  }

  public clearSessionTotpSetup(sessionId: string): void {
    this.pendingTotpSetups.delete(hashToken(sessionId));
  }

  public setSessionWebAuthnChallenge(sessionId: string, challenge: WebAuthnChallengeRecord): void {
    this.sessionChallenges.set(hashToken(sessionId), challenge);
  }

  /**
   * Atomically retrieves and removes the WebAuthn challenge for a session (single use).
   */
  public consumeSessionWebAuthnChallenge(
    sessionId: string,
    expectedKind: WebAuthnChallengeRecord['kind'],
    now = Date.now()
  ): WebAuthnChallengeRecord | null {
    const key = hashToken(sessionId);
    const entry = this.sessionChallenges.get(key);
    this.sessionChallenges.delete(key);
    if (!entry || entry.kind !== expectedKind || entry.expiresAt <= now) {
      return null;
    }
    return entry;
  }
}
