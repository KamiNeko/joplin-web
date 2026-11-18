import assert from 'node:assert/strict';
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, mock as testMock, test } from 'node:test';
import type { AppConfig } from '../src/config.js';
import { buildDemoItems, DEMO_EMAIL, DEMO_PASSWORD } from '../demo/seed.js';
import { startMockJoplinServer, type MockJoplinServer } from '../demo/mock-joplin-server.js';

let joplinMock: MockJoplinServer;
let baseConfig: AppConfig;
let createApp: typeof import('../src/app.js').createApp;
let loadConfig: typeof import('../src/config.js').loadConfig;
let resolveWebAuthnRp: typeof import('../src/config.js').resolveWebAuthnRp;
let ConfigError: typeof import('../src/config.js').ConfigError;
let computeTotp: typeof import('../src/services/totp.js').computeTotp;
let verifyTotp: typeof import('../src/services/totp.js').verifyTotp;
let ownerKeyForUser: typeof import('../src/services/two-factor-store.js').ownerKeyForUser;

const servers: Server[] = [];
const tempDirs: string[] = [];

before(async () => {
  joplinMock = await startMockJoplinServer({ email: DEMO_EMAIL, password: DEMO_PASSWORD, items: buildDemoItems() });
  process.env.JOPLIN_SERVER_URL = joplinMock.url;
  process.env.CACHE_TTL_MS = '0';
  ({ loadConfig, resolveWebAuthnRp, ConfigError } = await import('../src/config.js'));
  ({ createApp } = await import('../src/app.js'));
  ({ computeTotp, verifyTotp } = await import('../src/services/totp.js'));
  ({ ownerKeyForUser } = await import('../src/services/two-factor-store.js'));
  baseConfig = { ...loadConfig(), clientDistPath: '/nonexistent', corsOrigin: 'http://localhost:5173' };
});

after(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await joplinMock.close();
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(prefix = 'joplin-2fa-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function startApp(overrides: Partial<AppConfig> = {}): Promise<{ baseUrl: string; server: Server; cacheDir: string | null }> {
  const cacheDir = overrides.cacheDir === undefined ? await makeTempDir() : overrides.cacheDir;
  const app = createApp({ ...baseConfig, ...overrides, cacheDir });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    server,
    cacheDir,
  };
}

class CookieJar {
  private cookies = new Map<string, string>();

  ingest(headers: Headers): void {
    for (const raw of headers.getSetCookie()) {
      const semi = raw.indexOf(';');
      const nv = semi === -1 ? raw : raw.slice(0, semi);
      const eq = nv.indexOf('=');
      if (eq === -1) continue;
      const name = nv.slice(0, eq).trim();
      const val = nv.slice(eq + 1).trim();
      const attrs = semi === -1 ? '' : raw.slice(semi + 1);
      if (!val || /Max-Age=0\b/i.test(attrs) || /Expires=Thu, 01 Jan 1970/i.test(attrs)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, val);
      }
    }
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

async function call(
  baseUrl: string,
  reqPath: string,
  init: RequestInit & { json?: unknown; jar?: CookieJar } = {}
) {
  const headers = new Headers(init.headers);
  if (init.jar && !headers.has('Cookie')) {
    const c = init.jar.header();
    if (c) headers.set('Cookie', c);
  }
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`${baseUrl}${reqPath}`, { ...init, headers, body, redirect: 'manual' });
  if (init.jar) init.jar.ingest(res.headers);
  const text = await res.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // plain text
  }
  return { status: res.status, data, headers: res.headers };
}

/**
 * Software P-256 WebAuthn authenticator producing real attestation objects and ES256 assertions
 * accepted by @simplewebauthn/server (using pure Node crypto + deterministic CBOR).
 */
class SoftwareAuthenticator {
  public readonly credentialId: Buffer;
  public readonly credentialIdB64Url: string;
  public counter = 0;
  private readonly privateKey;
  private readonly cosePublicKey: Buffer;

  constructor() {
    this.credentialId = randomBytes(32);
    this.credentialIdB64Url = this.credentialId.toString('base64url');
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    const x = Buffer.from(jwk.x!, 'base64url');
    const y = Buffer.from(jwk.y!, 'base64url');
    assert.equal(x.length, 32);
    assert.equal(y.length, 32);
    // COSE EC2 P-256 key map { 1: 2, 3: -7, -1: 1, -2: x, -3: y }
    this.cosePublicKey = Buffer.concat([
      Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
      x,
      Buffer.from([0x22, 0x58, 0x20]),
      y,
    ]);
  }

  private encodeBstr(buf: Buffer): Buffer {
    if (buf.length < 24) return Buffer.concat([Buffer.from([0x40 + buf.length]), buf]);
    if (buf.length < 256) return Buffer.concat([Buffer.from([0x58, buf.length]), buf]);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(buf.length, 0);
    return Buffer.concat([Buffer.from([0x59]), len, buf]);
  }

  public makeRegistrationResponse(
    options: { challenge: string; rp: { id: string } },
    origin: string,
    opts: { flags?: number; counter?: number } = {}
  ) {
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: 'webauthn.create',
        challenge: options.challenge,
        origin,
        crossOrigin: false,
      }),
      'utf8'
    );

    const rpIdHash = createHash('sha256').update(options.rp.id).digest();
    const flags = opts.flags ?? 0x45; // UP (0x01) | UV (0x04) | AT (0x40)
    const signCount = Buffer.alloc(4);
    signCount.writeUInt32BE(opts.counter ?? this.counter, 0);
    const aaguid = Buffer.alloc(16, 0);
    const credIdLen = Buffer.alloc(2);
    credIdLen.writeUInt16BE(this.credentialId.length, 0);

    const authData = Buffer.concat([
      rpIdHash,
      Buffer.from([flags]),
      signCount,
      aaguid,
      credIdLen,
      this.credentialId,
      this.cosePublicKey,
    ]);

    // CBOR map { "fmt": "none", "attStmt": {}, "authData": <bstr> }
    const attestationObject = Buffer.concat([
      Buffer.from([0xa3]),
      Buffer.from([0x63]),
      Buffer.from('fmt'),
      Buffer.from([0x64]),
      Buffer.from('none'),
      Buffer.from([0x67]),
      Buffer.from('attStmt'),
      Buffer.from([0xa0]),
      Buffer.from([0x68]),
      Buffer.from('authData'),
      this.encodeBstr(authData),
    ]);

    return {
      id: this.credentialIdB64Url,
      rawId: this.credentialIdB64Url,
      type: 'public-key' as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        attestationObject: attestationObject.toString('base64url'),
        transports: ['internal'],
      },
    };
  }

  public makeAuthenticationResponse(
    options: { challenge: string; rpId?: string },
    origin: string,
    opts: { rpId?: string; flags?: number; counter?: number; corruptSignature?: boolean } = {}
  ) {
    const rpId = opts.rpId ?? options.rpId ?? new URL(origin).hostname;
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: options.challenge,
        origin,
        crossOrigin: false,
      }),
      'utf8'
    );
    const rpIdHash = createHash('sha256').update(rpId).digest();
    const flags = opts.flags ?? 0x05; // UP (0x01) | UV (0x04)
    const signCount = Buffer.alloc(4);
    signCount.writeUInt32BE(opts.counter ?? this.counter, 0);
    const authenticatorData = Buffer.concat([rpIdHash, Buffer.from([flags]), signCount]);

    const clientDataHash = createHash('sha256').update(clientDataJSON).digest();
    const signedData = Buffer.concat([authenticatorData, clientDataHash]);
    const signer = createSign('SHA256');
    signer.update(signedData);
    const signature = signer.sign(this.privateKey);
    if (opts.corruptSignature) signature[signature.length - 1] ^= 0xff;

    return {
      id: this.credentialIdB64Url,
      rawId: this.credentialIdB64Url,
      type: 'public-key' as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        authenticatorData: authenticatorData.toString('base64url'),
        signature: signature.toString('base64url'),
      },
    };
  }
}

/** Enrolls TOTP on a fresh server instance (via forced enrollment when require2fa=true, or Settings when false) */
async function setupUserWithTotp(
  options: {
    require2fa?: boolean;
    trustDevice?: boolean;
    userAgent?: string;
    trustProxy?: AppConfig['trustProxy'];
    publicUrl?: string;
  } = {}
) {
  const require2fa = options.require2fa ?? true;
  const { baseUrl, server, cacheDir } = await startApp({
    require2fa,
    ...(options.trustProxy !== undefined ? { trustProxy: options.trustProxy } : {}),
    ...(options.publicUrl !== undefined ? { publicUrl: options.publicUrl } : {}),
  });
  const jar = new CookieJar();
  const baseHeaders: Record<string, string> = {
    Origin: options.publicUrl ?? baseUrl,
    ...(options.userAgent ? { 'User-Agent': options.userAgent } : {}),
  };
  const login = await call(baseUrl, '/api/auth/login', {
    method: 'POST',
    headers: baseHeaders,
    jar,
    json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
  });
  assert.equal(login.status, 200);
  if (require2fa) {
    assert.equal(login.data.twoFactor.mustEnroll, true);
  } else {
    assert.equal(login.data.twoFactor, undefined);
  }

  const setup = await call(baseUrl, '/api/auth/2fa/totp/setup', {
    method: 'POST',
    headers: baseHeaders,
    jar,
    json: {},
  });
  assert.equal(setup.status, 200);

  const code = computeTotp(setup.data.secret);
  const confirm = await call(baseUrl, '/api/auth/2fa/totp/confirm', {
    method: 'POST',
    headers: baseHeaders,
    jar,
    json: { code, trustDevice: Boolean(options.trustDevice) },
  });
  assert.equal(confirm.status, 200);
  assert.equal(confirm.data.recoveryCodes.length, 10);

  const userId = (confirm.data.userId ?? login.data.userId) as string;

  return {
    baseUrl,
    server,
    cacheDir: cacheDir!,
    jar,
    secret: setup.data.secret as string,
    userId,
    recoveryCodes: confirm.data.recoveryCodes as string[],
    qrDataUrl: setup.data.qrDataUrl as string,
    otpauthUri: setup.data.otpauthUri as string,
  };
}

describe('configuration and WebAuthn RP rules', () => {
  test('REQUIRE_2FA=true without CACHE_DIR throws ConfigError with clear message', () => {
    assert.throws(
      () =>
        loadConfig({
          JOPLIN_SERVER_URL: 'https://notes.example.com',
          REQUIRE_2FA: 'true',
        }),
      (err: unknown) => err instanceof ConfigError && /CACHE_DIR/i.test(err.message)
    );
    const defaults = loadConfig({ JOPLIN_SERVER_URL: 'https://notes.example.com' });
    assert.equal(defaults.require2fa, false);
    assert.equal(defaults.cacheDir, null);
    assert.throws(
      () => loadConfig({ JOPLIN_SERVER_URL: 'https://notes.example.com', REQUIRE_2FA: 'maybe' }),
      ConfigError
    );
  });

  test('createApp refuses to start if REQUIRE_2FA=true and CACHE_DIR is a regular file', async () => {
    const dir = await makeTempDir();
    const badPath = path.join(dir, 'not-a-directory');
    await writeFile(badPath, 'x');
    assert.throws(() => createApp({ ...baseConfig, require2fa: true, cacheDir: badPath }));
  });

  test('WebAuthn RP resolves from PUBLIC_URL or http://localhost in dev only', () => {
    assert.deepEqual(
      resolveWebAuthnRp({ publicUrl: 'https://notes.example.com', nodeEnv: 'production' }, 'https://other.example'),
      { rpId: 'notes.example.com', expectedOrigin: 'https://notes.example.com' }
    );
    assert.deepEqual(
      resolveWebAuthnRp({ publicUrl: null, nodeEnv: 'development' }, 'http://localhost:5173'),
      { rpId: 'localhost', expectedOrigin: 'http://localhost:5173' }
    );
    assert.equal(resolveWebAuthnRp({ publicUrl: null, nodeEnv: 'development' }, 'http://127.0.0.1:5173'), null);
    assert.equal(resolveWebAuthnRp({ publicUrl: null, nodeEnv: 'development' }, 'https://localhost:5173'), null);
    assert.equal(resolveWebAuthnRp({ publicUrl: null, nodeEnv: 'development' }, 'http://evil.com'), null);
    assert.equal(resolveWebAuthnRp({ publicUrl: null, nodeEnv: 'production' }, 'http://localhost:5173'), null);
  });
});

describe('TOTP and recovery code login flows', () => {
  test('pending cookie never grants API access and cannot enroll when already enrolled', async () => {
    const { baseUrl, jar, userId } = await setupUserWithTotp({ require2fa: false });

    // Log out, then start fresh 2FA login
    await call(baseUrl, '/api/auth/logout', { method: 'POST', headers: { Origin: baseUrl }, jar });
    assert.equal(jar.get('joplin_web_session'), undefined);

    const login = await call(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { Origin: baseUrl },
      jar,
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });
    assert.equal(login.status, 200);
    assert.equal(login.data.sessionId, undefined);
    assert.equal(login.data.twoFactor.required, true);
    assert.equal(login.data.twoFactor.mustEnroll, false);
    assert.deepEqual(login.data.twoFactor.methods, ['totp', 'recovery']);

    const pendingVal = jar.get('joplin_web_2fa_pending');
    assert.ok(pendingVal, 'pending cookie set');
    assert.equal(jar.get('joplin_web_session'), undefined, 'no session cookie before 2FA');

    // Protected routes must reject the pending cookie and even using it as a Bearer token
    assert.equal((await call(baseUrl, '/api/auth/check', { jar })).status, 401);
    assert.equal((await call(baseUrl, '/api/notes', { jar })).status, 401);
    assert.equal((await call(baseUrl, '/api/auth/2fa/status', { jar })).status, 401);
    assert.equal(
      (await call(baseUrl, '/api/notes', { headers: { Authorization: `Bearer ${pendingVal}` } })).status,
      401
    );

    // CSRF origin-check rejects cookie-authenticated writes with missing or foreign Origin
    assert.equal(
      (await call(baseUrl, '/api/auth/2fa/totp/verify', { method: 'POST', jar, json: { code: '000000' } })).status,
      403
    );
    assert.equal(
      (
        await call(baseUrl, '/api/auth/2fa/totp/verify', {
          method: 'POST',
          headers: { Origin: 'https://evil.example' },
          jar,
          json: { code: '000000' },
        })
      ).status,
      403
    );

    // Already-enrolled account in pending state CANNOT hit enrollment endpoints (fail closed)
    assert.equal(
      (await call(baseUrl, '/api/auth/2fa/totp/setup', { method: 'POST', headers: { Origin: baseUrl }, jar, json: {} }))
        .status,
      403
    );
    assert.equal(
      (
        await call(baseUrl, '/api/auth/2fa/passkey/register/options', {
          method: 'POST',
          headers: { Origin: baseUrl },
          jar,
          json: {},
        })
      ).status,
      403
    );
    assert.ok(userId);
  });

  test('TOTP setup secret stays inactive until confirmed with a valid code', async () => {
    const { baseUrl } = await startApp({ require2fa: true });
    const jar1 = new CookieJar();
    await call(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { Origin: baseUrl },
      jar: jar1,
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });
    const setup = await call(baseUrl, '/api/auth/2fa/totp/setup', {
      method: 'POST',
      headers: { Origin: baseUrl },
      jar: jar1,
      json: {},
    });
    assert.equal(setup.status, 200);
    assert.match(setup.data.otpauthUri, /^otpauth:\/\/totp\//);
    assert.match(setup.data.qrDataUrl, /^data:image\/svg\+xml;base64,/);

    // New login before confirming still sees mustEnroll: true and no totp method
    const jar2 = new CookieJar();
    const login2 = await call(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { Origin: baseUrl },
      jar: jar2,
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });
    assert.equal(login2.data.twoFactor.mustEnroll, true);
    assert.deepEqual(login2.data.twoFactor.methods, []);
  });

  test('TOTP verification accepts +-1 step, rejects replay of same step, and enforces 5-attempt cap', async () => {
    testMock.timers.enable({ apis: ['Date'], now: 1_700_000_015_000 }); // mid-30s slot
    try {
      const { baseUrl, secret } = await setupUserWithTotp({ require2fa: false });

      // Advance one 30s step before next test login
      testMock.timers.setTime(1_700_000_045_000);
      const jar = new CookieJar();
      await call(baseUrl, '/api/auth/login', {
        method: 'POST',
        headers: { Origin: baseUrl },
        jar,
        json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
      });

      // Valid +1 / -1 window test
      const plusOneCode = computeTotp(secret, 1_700_000_045_000 + 30_000);
      const pendingBefore = jar.get('joplin_web_2fa_pending')!;
      const ok = await call(baseUrl, '/api/auth/2fa/totp/verify', {
        method: 'POST',
        headers: { Origin: baseUrl },
        jar,
        json: { code: plusOneCode },
      });
      assert.equal(ok.status, 200);
      assert.ok(jar.get('joplin_web_session'), 'session cookie issued after TOTP verify');
      assert.equal(jar.get('joplin_web_2fa_pending'), undefined, 'pending cookie cleared');

      // Single-use pending token check: replaying captured pending cookie fails
      const replayPending = await call(baseUrl, '/api/auth/2fa/totp/verify', {
        method: 'POST',
        headers: { Origin: baseUrl, Cookie: `joplin_web_2fa_pending=${pendingBefore}` },
        json: { code: plusOneCode },
      });
      assert.equal(replayPending.status, 401);
      assert.equal(replayPending.data.expired, true);

      // Next login: replaying the ALREADY accepted TOTP code (or even current step earlier than lastUsedStep) MUST fail
      const jar2 = new CookieJar();
      await call(baseUrl, '/api/auth/login', {
        method: 'POST',
        headers: { Origin: baseUrl },
        jar: jar2,
        json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
      });
      const replayed = await call(baseUrl, '/api/auth/2fa/totp/verify', {
        method: 'POST',
        headers: { Origin: baseUrl },
        jar: jar2,
        json: { code: plusOneCode },
      });
      assert.equal(replayed.status, 401);
      assert.equal(replayed.data.attemptsRemaining, 4);

      // Burn the remaining 4 attempts -> 5th failure terminates pending login and ends upstream Joplin session
      const beforeSessionsCount = joplinMock.sessions.size;
      for (let i = 0; i < 4; i++) {
        const fail = await call(baseUrl, '/api/auth/2fa/totp/verify', {
          method: 'POST',
          headers: { Origin: baseUrl },
          jar: jar2,
          json: { code: '000000' },
        });
        assert.equal(fail.status, 401);
        assert.equal(fail.data.attemptsRemaining, 3 - i);
        if (i === 3) {
          assert.equal(fail.data.expired, true);
        }
      }
      assert.equal(joplinMock.sessions.size, beforeSessionsCount - 1, 'upstream Joplin session ended on attempt cap');
      assert.equal(jar2.get('joplin_web_2fa_pending'), undefined);

      // Even advancing to a fresh valid TOTP step cannot revive the killed pending login
      testMock.timers.setTime(1_700_000_120_000);
      const freshCode = computeTotp(secret, 1_700_000_120_000);
      const afterCap = await call(baseUrl, '/api/auth/2fa/totp/verify', {
        method: 'POST',
        headers: { Origin: baseUrl },
        jar: jar2,
        json: { code: freshCode },
      });
      assert.equal(afterCap.status, 401);

      // Direct unit check on verifyTotp bounds
      assert.equal(verifyTotp(secret, computeTotp(secret, 1_700_000_120_000 - 60_000), { nowMs: 1_700_000_120_000 }).valid, false);
      assert.equal(verifyTotp(secret, computeTotp(secret, 1_700_000_120_000 + 60_000), { nowMs: 1_700_000_120_000 }).valid, false);
    } finally {
      testMock.timers.reset();
    }
  });

  test('pending login expiry (5 min) and pending logout both end the upstream Joplin session', async () => {
    testMock.timers.enable({ apis: ['Date'], now: 1_700_010_000_000 });
    try {
      const { baseUrl, secret } = await setupUserWithTotp({ require2fa: true });

      // Logout while in pending state
      const jarLogout = new CookieJar();
      await call(baseUrl, '/api/auth/login', {
        method: 'POST',
        headers: { Origin: baseUrl },
        jar: jarLogout,
        json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
      });
      const sessionsAfterLogin = joplinMock.sessions.size;
      const pendingLogout = await call(baseUrl, '/api/auth/logout', {
        method: 'POST',
        headers: { Origin: baseUrl },
        jar: jarLogout,
      });
      assert.equal(pendingLogout.status, 200);
      assert.equal(joplinMock.sessions.size, sessionsAfterLogin - 1, 'pending logout closed upstream session');

      // Expiry after 5 minutes
      const jarExpire = new CookieJar();
      await call(baseUrl, '/api/auth/login', {
        method: 'POST',
        headers: { Origin: baseUrl },
        jar: jarExpire,
        json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
      });
      const sessionsBeforeExpire = joplinMock.sessions.size;
      testMock.timers.setTime(1_700_010_000_000 + 5 * 60 * 1000 + 1);
      const code = computeTotp(secret, Date.now());
      const expiredRes = await call(baseUrl, '/api/auth/2fa/totp/verify', {
        method: 'POST',
        headers: { Origin: baseUrl },
        jar: jarExpire,
        json: { code },
      });
      assert.equal(expiredRes.status, 401);
      assert.equal(expiredRes.data.expired, true);
      assert.equal(joplinMock.sessions.size, sessionsBeforeExpire - 1, 'expired pending closed upstream session');
    } finally {
      testMock.timers.reset();
    }
  });

  test('recovery codes are single-use and regeneration invalidates prior unused codes', async () => {
    const { baseUrl, jar, recoveryCodes } = await setupUserWithTotp({ require2fa: true });

    // Log out, verify with first recovery code (even lowercase without dashes works)
    await call(baseUrl, '/api/auth/logout', { method: 'POST', headers: { Origin: baseUrl }, jar });
    const jar2 = new CookieJar();
    await call(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { Origin: baseUrl },
      jar: jar2,
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });

    const firstCode = recoveryCodes[0];
    const ok = await call(baseUrl, '/api/auth/2fa/recovery/verify', {
      method: 'POST',
      headers: { Origin: baseUrl },
      jar: jar2,
      json: { code: firstCode.toLowerCase().replace(/-/g, '') },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.recoveryCodesRemaining, 9);

    // Reusing firstCode fails
    await call(baseUrl, '/api/auth/logout', { method: 'POST', headers: { Origin: baseUrl }, jar: jar2 });
    const jar3 = new CookieJar();
    await call(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { Origin: baseUrl },
      jar: jar3,
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });
    const reuse = await call(baseUrl, '/api/auth/2fa/recovery/verify', {
      method: 'POST',
      headers: { Origin: baseUrl },
      jar: jar3,
      json: { code: firstCode },
    });
    assert.equal(reuse.status, 401);

    // Succeed with code[1], then regenerate in Settings
    const ok2 = await call(baseUrl, '/api/auth/2fa/recovery/verify', {
      method: 'POST',
      headers: { Origin: baseUrl },
      jar: jar3,
      json: { code: recoveryCodes[1] },
    });
    assert.equal(ok2.status, 200);

    const regen = await call(baseUrl, '/api/auth/2fa/recovery/regenerate', {
      method: 'POST',
      headers: { Origin: baseUrl },
      jar: jar3,
      json: {},
    });
    assert.equal(regen.status, 200);
    assert.equal(regen.data.recoveryCodes.length, 10);

    // Old unused code[2] no longer works after regeneration
    await call(baseUrl, '/api/auth/logout', { method: 'POST', headers: { Origin: baseUrl }, jar: jar3 });
    const jar4 = new CookieJar();
    await call(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { Origin: baseUrl },
      jar: jar4,
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });
    const staleOld = await call(baseUrl, '/api/auth/2fa/recovery/verify', {
      method: 'POST',
      headers: { Origin: baseUrl },
      jar: jar4,
      json: { code: recoveryCodes[2] },
    });
    assert.equal(staleOld.status, 401);

    // New regenerated code[0] works
    const newWorks = await call(baseUrl, '/api/auth/2fa/recovery/verify', {
      method: 'POST',
      headers: { Origin: baseUrl },
      jar: jar4,
      json: { code: regen.data.recoveryCodes[0] },
    });
    assert.equal(newWorks.status, 200);
  });
});

describe('WebAuthn passkeys (software P-256 authenticator)', () => {
  test('passkey registration, authentication, excludeCredentials, counter enforcement, and negative checks', async () => {
    const publicUrl = 'https://notes.example.com';
    const { baseUrl, cacheDir } = await startApp({ require2fa: true, publicUrl });
    const authn1 = new SoftwareAuthenticator();
    const authn2 = new SoftwareAuthenticator();

    const jar = new CookieJar();
    const login = await call(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { Origin: publicUrl },
      jar,
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });
    assert.equal(login.status, 200);
    assert.equal(login.data.twoFactor.mustEnroll, true);
    assert.equal(login.data.twoFactor.passkeysAvailable, true);

    const regOpts = await call(baseUrl, '/api/auth/2fa/passkey/register/options', {
      method: 'POST',
      headers: { Origin: publicUrl },
      jar,
      json: {},
    });
    assert.equal(regOpts.status, 200);
    assert.equal(regOpts.data.rp.id, 'notes.example.com');
    assert.equal(regOpts.data.authenticatorSelection.residentKey, 'preferred');
    assert.equal(regOpts.data.authenticatorSelection.userVerification, 'preferred');

    // Reject wrong origin on registration
    const wrongOriginReg = await call(baseUrl, '/api/auth/2fa/passkey/register/verify', {
      method: 'POST',
      headers: { Origin: publicUrl },
      jar,
      json: {
        name: 'Wrong origin',
        response: authn1.makeRegistrationResponse(regOpts.data, 'https://evil.com'),
      },
    });
    assert.equal(wrongOriginReg.status, 401);

    // Re-fetch options (previous challenge was consumed) and register validly (UP=1, UV=0 works with preferred UV)
    const regOpts2 = await call(baseUrl, '/api/auth/2fa/passkey/register/options', {
      method: 'POST',
      headers: { Origin: publicUrl },
      jar,
      json: {},
    });
    authn1.counter = 5;
    const regVerify = await call(baseUrl, '/api/auth/2fa/passkey/register/verify', {
      method: 'POST',
      headers: { Origin: publicUrl },
      jar,
      json: {
        name: 'Laptop Security Key',
        response: authn1.makeRegistrationResponse(regOpts2.data, publicUrl, { flags: 0x41, counter: 5 }),
      },
    });
    assert.equal(regVerify.status, 200);
    assert.equal(regVerify.data.verified, true);
    assert.equal(regVerify.data.passkey.name, 'Laptop Security Key');
    assert.equal(regVerify.data.recoveryCodes.length, 10);

    // Add a second passkey from Settings: verify excludeCredentials contains authn1
    const regOptsSecond = await call(baseUrl, '/api/auth/2fa/passkey/register/options', {
      method: 'POST',
      headers: { Origin: publicUrl },
      jar,
      json: {},
    });
    assert.equal(regOptsSecond.status, 200);
    assert.deepEqual(
      regOptsSecond.data.excludeCredentials.map((c: any) => c.id),
      [authn1.credentialIdB64Url]
    );
    // Register authn2 with counter 0
    const regVerify2 = await call(baseUrl, '/api/auth/2fa/passkey/register/verify', {
      method: 'POST',
      headers: { Origin: publicUrl },
      jar,
      json: {
        name: 'Zero-Counter Passkey',
        response: authn2.makeRegistrationResponse(regOptsSecond.data, publicUrl, { counter: 0 }),
      },
    });
    assert.equal(regVerify2.status, 200);
    assert.equal(regVerify2.data.recoveryCodes, undefined, 'recovery codes only generated on first factor');

    // Verify zero-counter key authenticates repeatedly even when counter remains 0
    for (let i = 0; i < 2; i++) {
      await call(baseUrl, '/api/auth/logout', { method: 'POST', headers: { Origin: publicUrl }, jar });
      await call(baseUrl, '/api/auth/login', {
        method: 'POST',
        headers: { Origin: publicUrl },
        jar,
        json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
      });
      const authOpts = await call(baseUrl, '/api/auth/2fa/passkey/auth/options', {
        method: 'POST',
        headers: { Origin: publicUrl },
        jar,
        json: {},
      });
      const authRes = await call(baseUrl, '/api/auth/2fa/passkey/auth/verify', {
        method: 'POST',
        headers: { Origin: publicUrl },
        jar,
        json: { response: authn2.makeAuthenticationResponse(authOpts.data, publicUrl, { counter: 0 }) },
      });
      assert.equal(authRes.status, 200);
    }

    // Rename & delete second passkey via Settings
    const rename = await call(
      baseUrl,
      `/api/auth/2fa/passkeys/${encodeURIComponent(authn2.credentialIdB64Url)}`,
      {
        method: 'PUT',
        headers: { Origin: publicUrl },
        jar,
        json: { name: 'Renamed Backup Key' },
      }
    );
    assert.equal(rename.status, 200);
    assert.equal(rename.data.passkey.name, 'Renamed Backup Key');

    const list = await call(baseUrl, '/api/auth/2fa/passkeys', { jar });
    assert.equal(list.status, 200);
    assert.equal(list.data.passkeys.length, 2);

    // Non-zero counter enforcement on authn1 (stored counter = 5)
    await call(baseUrl, '/api/auth/logout', { method: 'POST', headers: { Origin: publicUrl }, jar });
    const jarLogin = new CookieJar();
    await call(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { Origin: publicUrl },
      jar: jarLogin,
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });

    // Reject counter === 5 (stale / cloned authenticator)
    const optsBadCounter = await call(baseUrl, '/api/auth/2fa/passkey/auth/options', {
      method: 'POST',
      headers: { Origin: publicUrl },
      jar: jarLogin,
      json: {},
    });
    const staleRes = await call(baseUrl, '/api/auth/2fa/passkey/auth/verify', {
      method: 'POST',
      headers: { Origin: publicUrl },
      jar: jarLogin,
      json: { response: authn1.makeAuthenticationResponse(optsBadCounter.data, publicUrl, { counter: 5 }) },
    });
    assert.equal(staleRes.status, 401);

    // Reject counter regression (4 < 5)
    const optsRegress = await call(baseUrl, '/api/auth/2fa/passkey/auth/options', {
      method: 'POST',
      headers: { Origin: publicUrl },
      jar: jarLogin,
      json: {},
    });
    const regressRes = await call(baseUrl, '/api/auth/2fa/passkey/auth/verify', {
      method: 'POST',
      headers: { Origin: publicUrl },
      jar: jarLogin,
      json: { response: authn1.makeAuthenticationResponse(optsRegress.data, publicUrl, { counter: 4 }) },
    });
    assert.equal(regressRes.status, 401);

    // Reject tampered signature
    const optsSig = await call(baseUrl, '/api/auth/2fa/passkey/auth/options', {
      method: 'POST',
      headers: { Origin: publicUrl },
      jar: jarLogin,
      json: {},
    });
    const badSig = await call(baseUrl, '/api/auth/2fa/passkey/auth/verify', {
      method: 'POST',
      headers: { Origin: publicUrl },
      jar: jarLogin,
      json: {
        response: authn1.makeAuthenticationResponse(optsSig.data, publicUrl, { counter: 6, corruptSignature: true }),
      },
    });
    assert.equal(badSig.status, 401);

    // Valid counter increase (5 -> 7) succeeds
    const optsOk = await call(baseUrl, '/api/auth/2fa/passkey/auth/options', {
      method: 'POST',
      headers: { Origin: publicUrl },
      jar: jarLogin,
      json: {},
    });
    const assertionOk = authn1.makeAuthenticationResponse(optsOk.data, publicUrl, { counter: 7 });
    const okRes = await call(baseUrl, '/api/auth/2fa/passkey/auth/verify', {
      method: 'POST',
      headers: { Origin: publicUrl },
      jar: jarLogin,
      json: { response: assertionOk },
    });
    assert.equal(okRes.status, 200);

    // Confirm lastUsedAt & updated counter persisted on disk
    assert.ok(cacheDir);
  });
});

describe('API clients, trusted devices, step-up auth, and lockout rules', () => {
  test('API client one-call login works with totpCode and recoveryCode and fails closed otherwise', async () => {
    const { baseUrl, secret, recoveryCodes } = await setupUserWithTotp({ require2fa: true });
    const beforeCount = joplinMock.sessions.size;

    // Without 2FA code -> 401 { twoFactor: { required: true } }, no session, upstream ended
    const noCode = await call(baseUrl, '/api/auth/login', {
      method: 'POST',
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });
    assert.equal(noCode.status, 401);
    assert.equal(noCode.data.twoFactor?.required, true);
    assert.equal(noCode.data.sessionId, undefined);
    assert.equal(noCode.headers.getSetCookie().length, 0);
    assert.equal(joplinMock.sessions.size, beforeCount);

    // Wrong code -> 401 + upstream ended
    const wrong = await call(baseUrl, '/api/auth/login', {
      method: 'POST',
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD, totpCode: '000000' },
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.data.twoFactor?.required, true);
    assert.equal(wrong.data.sessionId, undefined);
    assert.equal(joplinMock.sessions.size, beforeCount);

    // Valid TOTP code in next step -> 200 with sessionId
    const nextMs = Date.now() + 30_000;
    const validTotp = await call(baseUrl, '/api/auth/login', {
      method: 'POST',
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD, totpCode: computeTotp(secret, nextMs) },
    });
    assert.equal(validTotp.status, 200);
    assert.ok(validTotp.data.sessionId);
    assert.equal((await call(baseUrl, '/api/notes', { headers: { Authorization: `Bearer ${validTotp.data.sessionId}` } })).status, 200);

    // One-call recoveryCode login + single-use enforcement
    const viaRecovery = await call(baseUrl, '/api/auth/login', {
      method: 'POST',
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD, recoveryCode: recoveryCodes[0] },
    });
    assert.equal(viaRecovery.status, 200);
    assert.ok(viaRecovery.data.sessionId);

    const replayRecovery = await call(baseUrl, '/api/auth/login', {
      method: 'POST',
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD, recoveryCode: recoveryCodes[0] },
    });
    assert.equal(replayRecovery.status, 401);
  });

  test('2FA routes enforce rate limiting', async () => {
    const { baseUrl } = await startApp({ require2fa: true });
    for (let i = 0; i < 30; i++) {
      const res = await call(baseUrl, '/api/auth/2fa/totp/verify', {
        method: 'POST',
        headers: { Origin: baseUrl },
        json: { code: '123456' },
      });
      assert.equal(res.status, 401);
    }
    const limited = await call(baseUrl, '/api/auth/2fa/totp/verify', {
      method: 'POST',
      headers: { Origin: baseUrl },
      json: { code: '123456' },
    });
    assert.equal(limited.status, 429);
  });

  test('trusted device skips login 2FA, requires step-up in Settings, and can be revoked', async () => {
    testMock.timers.enable({ apis: ['Date'], now: 1_700_020_000_000 });
    try {
      const { baseUrl, jar, secret } = await setupUserWithTotp({
        require2fa: true,
        trustDevice: true,
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/125.0',
      });
      const tdCookie = jar.get('joplin_web_trusted_device');
      assert.ok(tdCookie, 'trusted device cookie issued');

      // Logout keeps trusted-device cookie
      await call(baseUrl, '/api/auth/logout', { method: 'POST', headers: { Origin: baseUrl }, jar });
      assert.ok(jar.get('joplin_web_trusted_device'));

      // Next browser login bypasses 2FA directly to a full session
      const quickLogin = await call(baseUrl, '/api/auth/login', {
        method: 'POST',
        headers: { Origin: baseUrl, 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/125.0' },
        jar,
        json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
      });
      assert.equal(quickLogin.status, 200);
      assert.equal(quickLogin.data.twoFactor, undefined);
      assert.ok(quickLogin.data.userId);
      assert.ok(jar.get('joplin_web_session'));
      assert.equal((await call(baseUrl, '/api/notebooks', { jar })).status, 200);

      // Trusted-device login does NOT satisfy step-up for sensitive changes
      const devices = await call(baseUrl, '/api/auth/2fa/trusted-devices', { jar });
      assert.equal(devices.status, 200);
      assert.equal(devices.data.devices.length, 1);
      assert.equal(devices.data.devices[0].current, true);
      assert.match(devices.data.devices[0].label, /Chrome on Linux/);

      const blockedRegen = await call(baseUrl, '/api/auth/2fa/recovery/regenerate', {
        method: 'POST',
        headers: { Origin: baseUrl },
        jar,
        json: {},
      });
      assert.equal(blockedRegen.status, 403);
      assert.equal(blockedRegen.data.stepUpRequired, true);

      // Wrong step-up code returns 400 (must NOT return 401 to avoid triggering SessionExpiredDialog)
      const badStepUp = await call(baseUrl, '/api/auth/2fa/step-up/totp', {
        method: 'POST',
        headers: { Origin: baseUrl },
        jar,
        json: { code: '000000' },
      });
      assert.equal(badStepUp.status, 400);

      // Step-up at next 30s step unlocks security changes, including revoking all trusted devices
      testMock.timers.setTime(1_700_020_030_000);
      const stepUp = await call(baseUrl, '/api/auth/2fa/step-up/totp', {
        method: 'POST',
        headers: { Origin: baseUrl },
        jar,
        json: { code: computeTotp(secret, Date.now()) },
      });
      assert.equal(stepUp.status, 200);

      const revokeAll = await call(baseUrl, '/api/auth/2fa/trusted-devices', {
        method: 'DELETE',
        headers: { Origin: baseUrl },
        jar,
      });
      assert.equal(revokeAll.status, 200);
      assert.equal(jar.get('joplin_web_trusted_device'), undefined, 'trusted device cookie cleared');

      // Re-attaching the captured stale trusted device token does NOT bypass 2FA
      await call(baseUrl, '/api/auth/logout', { method: 'POST', headers: { Origin: baseUrl }, jar });
      const loginAfterRevoke = await call(baseUrl, '/api/auth/login', {
        method: 'POST',
        headers: { Origin: baseUrl, Cookie: `joplin_web_trusted_device=${tdCookie}` },
        json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
      });
      assert.equal(loginAfterRevoke.status, 200);
      assert.equal(loginAfterRevoke.data.twoFactor?.required, true);
    } finally {
      testMock.timers.reset();
    }
  });

  test('step-up expiry, last-factor removal rules, and raw upstream token rejection', async () => {
    testMock.timers.enable({ apis: ['Date'], now: 1_700_030_000_000 });
    try {
      // REQUIRE_2FA=true refuses last factor removal
      const requiredCtx = await setupUserWithTotp({ require2fa: true });
      const blockedDelete = await call(requiredCtx.baseUrl, '/api/auth/2fa/totp', {
        method: 'DELETE',
        headers: { Origin: requiredCtx.baseUrl },
        jar: requiredCtx.jar,
      });
      assert.equal(blockedDelete.status, 400);

      // Step-up expires after 5 minutes
      testMock.timers.setTime(1_700_030_000_000 + 5 * 60 * 1000 + 1);
      const expiredStepUp = await call(requiredCtx.baseUrl, '/api/auth/2fa/recovery/regenerate', {
        method: 'POST',
        headers: { Origin: requiredCtx.baseUrl },
        jar: requiredCtx.jar,
        json: {},
      });
      assert.equal(expiredStepUp.status, 403);
      assert.equal(expiredStepUp.data.stepUpRequired, true);

      // Raw Joplin Server token obtained outside Joplin Web cannot bypass requireAuth when CACHE_DIR is active
      const directRes = await fetch(`${joplinMock.url}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
      });
      const directSession = (await directRes.json()) as { id: string };
      assert.equal(
        (await call(requiredCtx.baseUrl, '/api/notes', { headers: { Authorization: `Bearer ${directSession.id}` } })).status,
        401
      );

      // REQUIRE_2FA=false allows removing the last factor and clears recovery codes & trusted devices
      const optionalCtx = await setupUserWithTotp({ require2fa: false });
      await call(optionalCtx.baseUrl, '/api/auth/logout', {
        method: 'POST',
        headers: { Origin: optionalCtx.baseUrl },
        jar: optionalCtx.jar,
      });
      await call(optionalCtx.baseUrl, '/api/auth/login', {
        method: 'POST',
        headers: { Origin: optionalCtx.baseUrl },
        jar: optionalCtx.jar,
        json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
      });
      testMock.timers.setTime(1_700_030_000_000 + 6 * 60 * 1000);
      const trustVerify = await call(optionalCtx.baseUrl, '/api/auth/2fa/totp/verify', {
        method: 'POST',
        headers: { Origin: optionalCtx.baseUrl },
        jar: optionalCtx.jar,
        json: { code: computeTotp(optionalCtx.secret, Date.now()), trustDevice: true },
      });
      assert.equal(trustVerify.status, 200);
      assert.ok(optionalCtx.jar.get('joplin_web_trusted_device'), 'trusted device cookie present before removal');

      const delOpt = await call(optionalCtx.baseUrl, '/api/auth/2fa/totp', {
        method: 'DELETE',
        headers: { Origin: optionalCtx.baseUrl },
        jar: optionalCtx.jar,
      });
      assert.equal(delOpt.status, 200);
      assert.equal(optionalCtx.jar.get('joplin_web_trusted_device'), undefined);

      // Subsequent login succeeds in 1 step
      await call(optionalCtx.baseUrl, '/api/auth/logout', {
        method: 'POST',
        headers: { Origin: optionalCtx.baseUrl },
        jar: optionalCtx.jar,
      });
      const relogin = await call(optionalCtx.baseUrl, '/api/auth/login', {
        method: 'POST',
        headers: { Origin: optionalCtx.baseUrl },
        jar: optionalCtx.jar,
        json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
      });
      assert.equal(relogin.status, 200);
      assert.equal(relogin.data.twoFactor, undefined);
      assert.ok(optionalCtx.jar.get('joplin_web_session'));
    } finally {
      testMock.timers.reset();
    }
  });
});

describe('storage permissions, fail-closed corruption, restarts, and log redaction', () => {
  test('0600 file permissions, atomic writes, restart survival, lockout reset, and corrupted file fail-closed', async () => {
    const { baseUrl, server, cacheDir, userId, secret, recoveryCodes, qrDataUrl, otpauthUri } =
      await setupUserWithTotp({ require2fa: false });

    const authDir = path.join(cacheDir, 'auth');
    const dirStat = await stat(authDir);
    assert.equal(dirStat.mode & 0o777, 0o700);

    const userFile = path.join(authDir, `${ownerKeyForUser(userId)}.json`);
    const fileStat = await stat(userFile);
    assert.equal(fileStat.mode & 0o777, 0o600);

    const files = await readdir(authDir);
    assert.ok(!files.some((f) => f.endsWith('.tmp')), 'no temporary files left behind');

    // Stop first server and start a new app instance pointing at the same CACHE_DIR
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));

    const restarted = await startApp({ cacheDir, require2fa: false });
    const jar = new CookieJar();
    const login = await call(restarted.baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { Origin: restarted.baseUrl },
      jar,
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });
    assert.equal(login.status, 200);
    assert.equal(login.data.twoFactor?.required, true, '2FA enrollment survives server restart');

    // Corrupting the 2FA file fails closed rather than silently dropping 2FA
    await writeFile(userFile, '{corrupted json');
    await chmod(userFile, 0o600);
    const sessionsBeforeCorrupt = joplinMock.sessions.size;
    const corruptLogin = await call(restarted.baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { Origin: restarted.baseUrl },
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });
    assert.equal(corruptLogin.status, 500);
    assert.equal(joplinMock.sessions.size, sessionsBeforeCorrupt, 'failed-closed login cleaned up upstream session');

    // Admin lockout reset = deleting CACHE_DIR/auth/<ownerKey>.json resets user cleanly
    await rm(userFile);
    const resetJar = new CookieJar();
    const afterReset = await call(restarted.baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { Origin: restarted.baseUrl },
      jar: resetJar,
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });
    assert.equal(afterReset.status, 200);
    assert.equal(afterReset.data.twoFactor, undefined);
    assert.ok(secret && recoveryCodes.length === 10 && qrDataUrl && otpauthUri);
  });

  test('secrets, codes, and WebAuthn assertions are never written to console or HTTP logs', async () => {
    const capturedLogs: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origErr = console.error;
    const origStdoutWrite = process.stdout.write.bind(process.stdout);

    console.log = (...args: unknown[]) => capturedLogs.push(args.map(String).join(' '));
    console.warn = (...args: unknown[]) => capturedLogs.push(args.map(String).join(' '));
    console.error = (...args: unknown[]) => capturedLogs.push(args.map(String).join(' '));
    process.stdout.write = ((chunk: unknown) => {
      capturedLogs.push(String(chunk));
      return origStdoutWrite(chunk as string);
    }) as typeof process.stdout.write;

    let totpSecret = '';
    let otpauth = '';
    let qrUrl = '';
    let totpConfirmCode = '';
    let recoveryList: string[] = [];
    let assertionSig = '';

    try {
      testMock.timers.enable({ apis: ['Date'], now: 1_700_040_000_000 });
      const { baseUrl } = await startApp({ require2fa: true });
      const jar = new CookieJar();

      await call(baseUrl, '/api/auth/login', {
        method: 'POST',
        headers: { Origin: baseUrl },
        jar,
        json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
      });

      const setup = await call(baseUrl, '/api/auth/2fa/totp/setup', {
        method: 'POST',
        headers: { Origin: baseUrl },
        jar,
        json: {},
      });
      totpSecret = setup.data.secret;
      otpauth = setup.data.otpauthUri;
      qrUrl = setup.data.qrDataUrl;
      totpConfirmCode = computeTotp(totpSecret, Date.now());

      const confirm = await call(baseUrl, '/api/auth/2fa/totp/confirm', {
        method: 'POST',
        headers: { Origin: baseUrl },
        jar,
        json: { code: totpConfirmCode },
      });
      recoveryList = confirm.data.recoveryCodes;

      const regOpts = await call(baseUrl, '/api/auth/2fa/passkey/register/options', {
        method: 'POST',
        headers: { Origin: 'http://localhost:5173' },
        jar,
        json: {},
      });
      const authn = new SoftwareAuthenticator();
      await call(baseUrl, '/api/auth/2fa/passkey/register/verify', {
        method: 'POST',
        headers: { Origin: 'http://localhost:5173' },
        jar,
        json: { name: 'Key', response: authn.makeRegistrationResponse(regOpts.data, 'http://localhost:5173') },
      });

      const stepOpts = await call(baseUrl, '/api/auth/2fa/step-up/passkey/options', {
        method: 'POST',
        headers: { Origin: 'http://localhost:5173' },
        jar,
        json: {},
      });
      const assertion = authn.makeAuthenticationResponse(stepOpts.data, 'http://localhost:5173');
      assertionSig = assertion.response.signature;
      await call(baseUrl, '/api/auth/2fa/step-up/passkey/verify', {
        method: 'POST',
        headers: { Origin: 'http://localhost:5173' },
        jar,
        json: { response: assertion },
      });

      // Sensitive query params redacted by morgan logger
      await call(
        baseUrl,
        `/api/health?totpCode=${totpConfirmCode}&secret=${totpSecret}&recoveryCode=${recoveryList[0]}`
      );
    } finally {
      testMock.timers.reset();
      console.log = origLog;
      console.warn = origWarn;
      console.error = origErr;
      process.stdout.write = origStdoutWrite;
    }

    const combinedLogs = capturedLogs.join('\n');
    assert.ok(totpSecret.length > 10);
    assert.equal(combinedLogs.includes(totpSecret), false, 'TOTP secret must not appear in logs');
    assert.equal(combinedLogs.includes(otpauth), false, 'otpauth URI must not appear in logs');
    assert.equal(combinedLogs.includes(qrUrl), false, 'QR data URL must not appear in logs');
    assert.equal(combinedLogs.includes(totpConfirmCode), false, 'TOTP code must not appear in logs');
    assert.equal(combinedLogs.includes(assertionSig), false, 'WebAuthn signature must not appear in logs');
    for (const rc of recoveryList) {
      assert.equal(combinedLogs.includes(rc), false, 'recovery code must not appear in logs');
    }
  });
});

describe('stale mustEnroll race & concurrent enrollment protection', () => {
  test('attacker with pre-opened mustEnroll pending login cannot enroll passkey or TOTP after owner enrolls TOTP', async () => {
    const publicUrl = 'https://notes.example.com';
    const { baseUrl } = await startApp({ require2fa: true, publicUrl });
    const headers = { Origin: publicUrl };

    // Attacker opens pending login while account is unenrolled (mustEnroll=true)
    const attackerJar = new CookieJar();
    const attackerLogin = await call(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers,
      jar: attackerJar,
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });
    assert.equal(attackerLogin.status, 200);
    assert.equal(attackerLogin.data.twoFactor?.mustEnroll, true);

    // Attacker even pre-fetches passkey registration options before owner finishes enrolling
    const attackerRegOpts = await call(baseUrl, '/api/auth/2fa/passkey/register/options', {
      method: 'POST',
      headers,
      jar: attackerJar,
      json: {},
    });
    assert.equal(attackerRegOpts.status, 200);

    // Owner signs in and enrolls TOTP first
    const ownerJar = new CookieJar();
    await call(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers,
      jar: ownerJar,
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });
    const ownerSetup = await call(baseUrl, '/api/auth/2fa/totp/setup', {
      method: 'POST',
      headers,
      jar: ownerJar,
      json: {},
    });
    assert.equal(ownerSetup.status, 200);
    const ownerConfirm = await call(baseUrl, '/api/auth/2fa/totp/confirm', {
      method: 'POST',
      headers,
      jar: ownerJar,
      json: { code: computeTotp(ownerSetup.data.secret) },
    });
    assert.equal(ownerConfirm.status, 200);

    // Attacker's stale pending login MUST now be rejected (403) across all pending enrollment routes
    const latePasskeyOpts = await call(baseUrl, '/api/auth/2fa/passkey/register/options', {
      method: 'POST',
      headers,
      jar: attackerJar,
      json: {},
    });
    assert.equal(latePasskeyOpts.status, 403);

    const attackerAuthn = new SoftwareAuthenticator();
    const latePasskeyVerify = await call(baseUrl, '/api/auth/2fa/passkey/register/verify', {
      method: 'POST',
      headers,
      jar: attackerJar,
      json: {
        name: 'Attacker Key',
        response: attackerAuthn.makeRegistrationResponse(attackerRegOpts.data, publicUrl),
      },
    });
    assert.equal(latePasskeyVerify.status, 403);

    const lateTotpSetup = await call(baseUrl, '/api/auth/2fa/totp/setup', {
      method: 'POST',
      headers,
      jar: attackerJar,
      json: {},
    });
    assert.equal(lateTotpSetup.status, 403);

    // Attacker session was not promoted and no passkey was persisted
    assert.equal((await call(baseUrl, '/api/notes', { jar: attackerJar })).status, 401);
    const ownerPasskeys = await call(baseUrl, '/api/auth/2fa/passkeys', { jar: ownerJar });
    assert.equal(ownerPasskeys.status, 200);
    assert.equal(ownerPasskeys.data.passkeys.length, 0);
  });

  test('attacker with pre-opened mustEnroll pending login + TOTP secret cannot confirm TOTP after owner enrolls passkey', async () => {
    const publicUrl = 'https://notes.example.com';
    const { baseUrl } = await startApp({ require2fa: true, publicUrl });
    const headers = { Origin: publicUrl };

    // Attacker opens pending login and starts TOTP setup before owner enrolls
    const attackerJar = new CookieJar();
    const attackerLogin = await call(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers,
      jar: attackerJar,
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });
    assert.equal(attackerLogin.data.twoFactor?.mustEnroll, true);

    const attackerTotpSetup = await call(baseUrl, '/api/auth/2fa/totp/setup', {
      method: 'POST',
      headers,
      jar: attackerJar,
      json: {},
    });
    assert.equal(attackerTotpSetup.status, 200);

    // Owner signs in and enrolls a passkey first
    const ownerJar = new CookieJar();
    await call(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers,
      jar: ownerJar,
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });
    const ownerRegOpts = await call(baseUrl, '/api/auth/2fa/passkey/register/options', {
      method: 'POST',
      headers,
      jar: ownerJar,
      json: {},
    });
    const ownerAuthn = new SoftwareAuthenticator();
    const ownerRegVerify = await call(baseUrl, '/api/auth/2fa/passkey/register/verify', {
      method: 'POST',
      headers,
      jar: ownerJar,
      json: {
        name: 'Owner Key',
        response: ownerAuthn.makeRegistrationResponse(ownerRegOpts.data, publicUrl),
      },
    });
    assert.equal(ownerRegVerify.status, 200);

    // Attacker attempts to complete pre-started TOTP confirm -> MUST fail with 403
    const lateTotpConfirm = await call(baseUrl, '/api/auth/2fa/totp/confirm', {
      method: 'POST',
      headers,
      jar: attackerJar,
      json: { code: computeTotp(attackerTotpSetup.data.secret) },
    });
    assert.equal(lateTotpConfirm.status, 403);

    const lateTotpSetup = await call(baseUrl, '/api/auth/2fa/totp/setup', {
      method: 'POST',
      headers,
      jar: attackerJar,
      json: {},
    });
    assert.equal(lateTotpSetup.status, 403);

    // Attacker was not promoted and TOTP remains disabled on the account
    assert.equal((await call(baseUrl, '/api/notes', { jar: attackerJar })).status, 401);
    const status = await call(baseUrl, '/api/auth/2fa/status', { jar: ownerJar });
    assert.equal(status.status, 200);
    assert.equal(status.data.enrolled.totp, false);
    assert.equal(status.data.enrolled.passkeysCount, 1);
  });

  test('concurrent pending passkey enrollments allow only the first writer and reject the second with 403', async () => {
    const publicUrl = 'https://notes.example.com';
    const { baseUrl } = await startApp({ require2fa: true, publicUrl });
    const headers = { Origin: publicUrl };

    const jarA = new CookieJar();
    const jarB = new CookieJar();
    await call(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers,
      jar: jarA,
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });
    await call(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers,
      jar: jarB,
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });

    const optsA = await call(baseUrl, '/api/auth/2fa/passkey/register/options', {
      method: 'POST',
      headers,
      jar: jarA,
      json: {},
    });
    const optsB = await call(baseUrl, '/api/auth/2fa/passkey/register/options', {
      method: 'POST',
      headers,
      jar: jarB,
      json: {},
    });

    const authnA = new SoftwareAuthenticator();
    const authnB = new SoftwareAuthenticator();
    const [resA, resB] = await Promise.all([
      call(baseUrl, '/api/auth/2fa/passkey/register/verify', {
        method: 'POST',
        headers,
        jar: jarA,
        json: { name: 'Key A', response: authnA.makeRegistrationResponse(optsA.data, publicUrl) },
      }),
      call(baseUrl, '/api/auth/2fa/passkey/register/verify', {
        method: 'POST',
        headers,
        jar: jarB,
        json: { name: 'Key B', response: authnB.makeRegistrationResponse(optsB.data, publicUrl) },
      }),
    ]);

    const statuses = [resA.status, resB.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 403]);
    const winnerJar = resA.status === 200 ? jarA : jarB;
    const loserJar = resA.status === 200 ? jarB : jarA;
    assert.equal((await call(baseUrl, '/api/notes', { jar: loserJar })).status, 401);
    const passkeys = await call(baseUrl, '/api/auth/2fa/passkeys', { jar: winnerJar });
    assert.equal(passkeys.status, 200);
    assert.equal(passkeys.data.passkeys.length, 1);
  });
});

describe('first-factor enrollment session & trusted-device revocation', () => {
  test('enrolling first factor from Settings revokes all pre-existing sessions (API & browser) and keeps enrolling session; adding 2nd factor keeps other verified sessions', async () => {
    const publicUrl = 'https://notes.example.com';
    const { baseUrl } = await startApp({ require2fa: false, publicUrl });
    const headers = { Origin: publicUrl };

    // Create three pre-enrollment sessions: two browser cookies + one API bearer token
    const jar1 = new CookieJar();
    const jar2 = new CookieJar();
    await call(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers,
      jar: jar1,
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });
    await call(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers,
      jar: jar2,
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });
    const apiLogin = await call(baseUrl, '/api/auth/login', {
      method: 'POST',
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });
    assert.equal(apiLogin.status, 200);
    const apiToken = apiLogin.data.sessionId as string;
    assert.ok(apiToken);

    // Warm /api/notes on all three sessions so validation cache + note cache are populated
    assert.equal((await call(baseUrl, '/api/notes', { jar: jar1 })).status, 200);
    assert.equal((await call(baseUrl, '/api/notes', { jar: jar2 })).status, 200);
    assert.equal(
      (await call(baseUrl, '/api/notes', { headers: { Authorization: `Bearer ${apiToken}` } })).status,
      200
    );
    assert.equal(joplinMock.sessions.has(apiToken), true);

    // Enroll FIRST factor (TOTP) in jar1
    const setup = await call(baseUrl, '/api/auth/2fa/totp/setup', {
      method: 'POST',
      headers,
      jar: jar1,
      json: {},
    });
    assert.equal(setup.status, 200);
    const secret = setup.data.secret as string;
    const confirm = await call(baseUrl, '/api/auth/2fa/totp/confirm', {
      method: 'POST',
      headers,
      jar: jar1,
      json: { code: computeTotp(secret) },
    });
    assert.equal(confirm.status, 200);
    assert.equal(confirm.data.enrolled, true);

    // Enrolling session keeps working, while both other pre-existing sessions fail with 401 and are ended upstream
    assert.equal((await call(baseUrl, '/api/notes', { jar: jar1 })).status, 200);
    assert.equal((await call(baseUrl, '/api/notes', { jar: jar2 })).status, 401);
    assert.equal(
      (await call(baseUrl, '/api/notes', { headers: { Authorization: `Bearer ${apiToken}` } })).status,
      401
    );
    assert.equal(joplinMock.sessions.has(apiToken), false, 'revoked session ended upstream via Joplin Server');

    // Now verify that adding a SECOND factor does NOT revoke another verified session
    testMock.timers.enable({ apis: ['Date'], now: Date.now() + 30_000 });
    try {
      const verifiedJar = new CookieJar();
      await call(baseUrl, '/api/auth/login', {
        method: 'POST',
        headers,
        jar: verifiedJar,
        json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
      });
      const verify = await call(baseUrl, '/api/auth/2fa/totp/verify', {
        method: 'POST',
        headers,
        jar: verifiedJar,
        json: { code: computeTotp(secret, Date.now()) },
      });
      assert.equal(verify.status, 200);
      assert.equal((await call(baseUrl, '/api/notes', { jar: verifiedJar })).status, 200);

      // jar1 adds a passkey as a second factor (within its fresh 5-min step-up window)
      const regOpts = await call(baseUrl, '/api/auth/2fa/passkey/register/options', {
        method: 'POST',
        headers,
        jar: jar1,
        json: {},
      });
      assert.equal(regOpts.status, 200);
      const authn = new SoftwareAuthenticator();
      const regVerify = await call(baseUrl, '/api/auth/2fa/passkey/register/verify', {
        method: 'POST',
        headers,
        jar: jar1,
        json: { name: 'Second Factor', response: authn.makeRegistrationResponse(regOpts.data, publicUrl) },
      });
      assert.equal(regVerify.status, 200);

      // Verified session remains valid after adding a second factor
      assert.equal((await call(baseUrl, '/api/notes', { jar: verifiedJar })).status, 200);
    } finally {
      testMock.timers.reset();
    }
  });

  test('enrolling first factor via pending login revokes pre-existing sessions surviving a REQUIRE_2FA restart', async () => {
    const publicUrl = 'https://notes.example.com';
    const first = await startApp({ require2fa: false, publicUrl });

    // Create a session before REQUIRE_2FA was turned on
    const preLogin = await call(first.baseUrl, '/api/auth/login', {
      method: 'POST',
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });
    assert.equal(preLogin.status, 200);
    const preToken = preLogin.data.sessionId as string;
    assert.equal(
      (await call(first.baseUrl, '/api/notes', { headers: { Authorization: `Bearer ${preToken}` } })).status,
      200
    );

    first.server.closeAllConnections();
    await new Promise((resolve) => first.server.close(resolve));

    // Restart with REQUIRE_2FA=true on the same CACHE_DIR
    const restarted = await startApp({ cacheDir: first.cacheDir, require2fa: true, publicUrl });
    // Pre-existing session had twoFactorPassed=true in sessions.json, so it works before enrollment
    assert.equal(
      (await call(restarted.baseUrl, '/api/notes', { headers: { Authorization: `Bearer ${preToken}` } })).status,
      200
    );

    // Pre-seed a stale trusted device in the still-unenrolled user record to prove first-factor
    // enrollment wipes any pre-existing trustedDevices alongside pre-existing sessions
    const userId = preLogin.data.userId as string;
    const userRecordFile = path.join(first.cacheDir!, 'auth', `${ownerKeyForUser(userId)}.json`);
    const { readFile } = await import('node:fs/promises');
    await writeFile(
      userRecordFile,
      JSON.stringify({
        version: 1,
        userId,
        totp: null,
        passkeys: [],
        recoverySalt: null,
        recoveryCodes: [],
        trustedDevices: [
          {
            id: 'stale-td',
            tokenHash: 'deadbeef',
            label: 'Stale Browser',
            createdAt: Date.now() - 1000,
            lastUsedAt: Date.now() - 1000,
            expiresAt: Date.now() + 86_400_000,
          },
        ],
      })
    );
    await chmod(userRecordFile, 0o600);

    // Enroll first factor via pending enrollment
    const enrollJar = new CookieJar();
    const login2 = await call(restarted.baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { Origin: publicUrl },
      jar: enrollJar,
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });
    assert.equal(login2.data.twoFactor?.mustEnroll, true);

    const regOpts = await call(restarted.baseUrl, '/api/auth/2fa/passkey/register/options', {
      method: 'POST',
      headers: { Origin: publicUrl },
      jar: enrollJar,
      json: {},
    });
    const authn = new SoftwareAuthenticator();
    const regVerify = await call(restarted.baseUrl, '/api/auth/2fa/passkey/register/verify', {
      method: 'POST',
      headers: { Origin: publicUrl },
      jar: enrollJar,
      json: { name: 'Mandatory Key', response: authn.makeRegistrationResponse(regOpts.data, publicUrl) },
    });
    assert.equal(regVerify.status, 200);

    // Stale trusted device cleared by first-factor enrollment
    const updatedRecord = JSON.parse(await readFile(userRecordFile, 'utf8'));
    assert.deepEqual(updatedRecord.trustedDevices, []);

    // Promoted session works; pre-enrollment session gets 401 and is terminated upstream
    assert.equal((await call(restarted.baseUrl, '/api/notes', { jar: enrollJar })).status, 200);
    assert.equal(
      (await call(restarted.baseUrl, '/api/notes', { headers: { Authorization: `Bearer ${preToken}` } })).status,
      401
    );
    assert.equal(joplinMock.sessions.has(preToken), false);
  });
});

describe('per-user second-factor lockout and exponential backoff', () => {
  test('locks second-factor verification across logins/IPs/methods after 5 failures with exponential backoff (1..60 min), preserves password step & existing sessions, survives restart, and resets on success', async () => {
    const publicUrl = 'https://notes.example.com';
    testMock.timers.enable({ apis: ['Date'], now: 1_700_100_000_000 });
    try {
      const ctx = await setupUserWithTotp({
        require2fa: true,
        trustProxy: 1,
        publicUrl,
      });

      // Also enroll a passkey on the same account and keep `ctx.jar` as an active valid session
      const regOpts = await call(ctx.baseUrl, '/api/auth/2fa/passkey/register/options', {
        method: 'POST',
        headers: { Origin: publicUrl, 'X-Forwarded-For': '10.0.1.1' },
        jar: ctx.jar,
        json: {},
      });
      assert.equal(regOpts.status, 200);
      const authn = new SoftwareAuthenticator();
      const regVerify = await call(ctx.baseUrl, '/api/auth/2fa/passkey/register/verify', {
        method: 'POST',
        headers: { Origin: publicUrl, 'X-Forwarded-For': '10.0.1.1' },
        jar: ctx.jar,
        json: { name: 'Lockout Test Key', response: authn.makeRegistrationResponse(regOpts.data, publicUrl) },
      });
      assert.equal(regVerify.status, 200);

      // Pending login A from IP 1: burn 3 failed TOTP attempts
      const jarA = new CookieJar();
      await call(ctx.baseUrl, '/api/auth/login', {
        method: 'POST',
        headers: { Origin: publicUrl, 'X-Forwarded-For': '10.0.1.2' },
        jar: jarA,
        json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
      });
      for (let i = 0; i < 3; i++) {
        const res = await call(ctx.baseUrl, '/api/auth/2fa/totp/verify', {
          method: 'POST',
          headers: { Origin: publicUrl, 'X-Forwarded-For': '10.0.1.2' },
          jar: jarA,
          json: { code: '000000' },
        });
        assert.equal(res.status, 401);
      }

      // Pending login B from IP 2: 4th failure via invalid recovery code, 5th failure via bad passkey assertion -> 1-min lock!
      const jarB = new CookieJar();
      await call(ctx.baseUrl, '/api/auth/login', {
        method: 'POST',
        headers: { Origin: publicUrl, 'X-Forwarded-For': '10.0.1.3' },
        jar: jarB,
        json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
      });
      const recFail = await call(ctx.baseUrl, '/api/auth/2fa/recovery/verify', {
        method: 'POST',
        headers: { Origin: publicUrl, 'X-Forwarded-For': '10.0.1.3' },
        jar: jarB,
        json: { code: 'AAAA-AAAA-AAAA-AAAA' },
      });
      assert.equal(recFail.status, 401);

      const pkOpts = await call(ctx.baseUrl, '/api/auth/2fa/passkey/auth/options', {
        method: 'POST',
        headers: { Origin: publicUrl, 'X-Forwarded-For': '10.0.1.3' },
        jar: jarB,
        json: {},
      });
      const pkFail = await call(ctx.baseUrl, '/api/auth/2fa/passkey/auth/verify', {
        method: 'POST',
        headers: { Origin: publicUrl, 'X-Forwarded-For': '10.0.1.3' },
        jar: jarB,
        json: { response: authn.makeAuthenticationResponse(pkOpts.data, publicUrl, { corruptSignature: true }) },
      });
      assert.equal(pkFail.status, 401);

      // Advance 10s (still within 1-min lockout)
      testMock.timers.setTime(Date.now() + 10_000);

      // Already-authenticated session still works
      assert.equal((await call(ctx.baseUrl, '/api/notes', { jar: ctx.jar })).status, 200);

      // Password step still works and opens a pending login, only 2FA waits
      const jarLocked = new CookieJar();
      const pwOk = await call(ctx.baseUrl, '/api/auth/login', {
        method: 'POST',
        headers: { Origin: publicUrl, 'X-Forwarded-For': '10.0.1.4' },
        jar: jarLocked,
        json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
      });
      assert.equal(pwOk.status, 200);
      assert.equal(pwOk.data.twoFactor?.required, true);

      // Pending TOTP, recovery (even with valid codes!), passkey verify, and step-up ALL return 429 with retryAfter
      const lockedTotp = await call(ctx.baseUrl, '/api/auth/2fa/totp/verify', {
        method: 'POST',
        headers: { Origin: publicUrl, 'X-Forwarded-For': '10.0.1.4' },
        jar: jarLocked,
        json: { code: computeTotp(ctx.secret, Date.now()) },
      });
      assert.equal(lockedTotp.status, 429);
      assert.ok(lockedTotp.data.retryAfter > 0 && lockedTotp.data.retryAfter <= 60);
      assert.equal(Number(lockedTotp.headers.get('retry-after')), lockedTotp.data.retryAfter);

      const lockedRec = await call(ctx.baseUrl, '/api/auth/2fa/recovery/verify', {
        method: 'POST',
        headers: { Origin: publicUrl, 'X-Forwarded-For': '10.0.1.4' },
        jar: jarLocked,
        json: { code: ctx.recoveryCodes[0] },
      });
      assert.equal(lockedRec.status, 429);
      assert.ok(lockedRec.data.retryAfter > 0);

      const lockedPkOpts = await call(ctx.baseUrl, '/api/auth/2fa/passkey/auth/options', {
        method: 'POST',
        headers: { Origin: publicUrl, 'X-Forwarded-For': '10.0.1.4' },
        jar: jarLocked,
        json: {},
      });
      const lockedPk = await call(ctx.baseUrl, '/api/auth/2fa/passkey/auth/verify', {
        method: 'POST',
        headers: { Origin: publicUrl, 'X-Forwarded-For': '10.0.1.4' },
        jar: jarLocked,
        json: { response: authn.makeAuthenticationResponse(lockedPkOpts.data, publicUrl) },
      });
      assert.equal(lockedPk.status, 429);
      assert.ok(lockedPk.data.retryAfter > 0);

      const lockedStepUp = await call(ctx.baseUrl, '/api/auth/2fa/step-up/totp', {
        method: 'POST',
        headers: { Origin: publicUrl, 'X-Forwarded-For': '10.0.1.4' },
        jar: ctx.jar,
        json: { code: computeTotp(ctx.secret, Date.now()) },
      });
      assert.equal(lockedStepUp.status, 429);
      assert.ok(lockedStepUp.data.retryAfter > 0);

      // Lockout survives a server restart
      ctx.server.closeAllConnections();
      await new Promise((resolve) => ctx.server.close(resolve));
      const restarted = await startApp({ cacheDir: ctx.cacheDir, require2fa: true, trustProxy: 1, publicUrl });
      const restartJar = new CookieJar();
      await call(restarted.baseUrl, '/api/auth/login', {
        method: 'POST',
        headers: { Origin: publicUrl, 'X-Forwarded-For': '10.0.1.5' },
        jar: restartJar,
        json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
      });
      const lockedAfterRestart = await call(restarted.baseUrl, '/api/auth/2fa/totp/verify', {
        method: 'POST',
        headers: { Origin: publicUrl, 'X-Forwarded-For': '10.0.1.5' },
        jar: restartJar,
        json: { code: '000000' },
      });
      assert.equal(lockedAfterRestart.status, 429);
      assert.ok(lockedAfterRestart.data.retryAfter > 0);

      // Exponential backoff steps after initial 1 min lock: 2, 4, 8, 16, 32, 60, and still capped at 60 min
      const expectedMinutes = [2, 4, 8, 16, 32, 60, 60];
      let prevLockWaitMs = 60_000;
      for (let step = 0; step < expectedMinutes.length; step++) {
        testMock.timers.setTime(Date.now() + prevLockWaitMs);
        const failJar = new CookieJar();
        await call(restarted.baseUrl, '/api/auth/login', {
          method: 'POST',
          headers: { Origin: publicUrl, 'X-Forwarded-For': `10.0.2.${step + 1}` },
          jar: failJar,
          json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
        });
        const failRes = await call(restarted.baseUrl, '/api/auth/2fa/totp/verify', {
          method: 'POST',
          headers: { Origin: publicUrl, 'X-Forwarded-For': `10.0.2.${step + 1}` },
          jar: failJar,
          json: { code: '000000' },
        });
        assert.equal(failRes.status, 401);

        // Immediately verify next request sees expected backoff seconds
        const checkLock = await call(restarted.baseUrl, '/api/auth/2fa/totp/verify', {
          method: 'POST',
          headers: { Origin: publicUrl, 'X-Forwarded-For': `10.0.3.${step + 1}` },
          jar: failJar,
          json: { code: '000000' },
        });
        assert.equal(checkLock.status, 429);
        assert.equal(checkLock.data.retryAfter, expectedMinutes[step] * 60);
        prevLockWaitMs = expectedMinutes[step] * 60 * 1000;
      }

      // After final 60-min lock expires, valid verification succeeds and resets counter (plus unused recovery code wasn't consumed while locked)
      testMock.timers.setTime(Date.now() + 60 * 60 * 1000 + 1_000);
      const resetJar = new CookieJar();
      await call(restarted.baseUrl, '/api/auth/login', {
        method: 'POST',
        headers: { Origin: publicUrl, 'X-Forwarded-For': '10.0.4.1' },
        jar: resetJar,
        json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
      });
      const recStillValid = await call(restarted.baseUrl, '/api/auth/2fa/recovery/verify', {
        method: 'POST',
        headers: { Origin: publicUrl, 'X-Forwarded-For': '10.0.4.1' },
        jar: resetJar,
        json: { code: ctx.recoveryCodes[0] },
      });
      assert.equal(recStillValid.status, 200);
      assert.equal(recStillValid.data.recoveryCodesRemaining, 9);

      // Single subsequent wrong step-up returns 400 (not 429), proving counter reset to 0
      const postResetFail = await call(restarted.baseUrl, '/api/auth/2fa/step-up/totp', {
        method: 'POST',
        headers: { Origin: publicUrl, 'X-Forwarded-For': '10.0.4.2' },
        jar: resetJar,
        json: { code: '000000' },
      });
      assert.equal(postResetFail.status, 400);
    } finally {
      testMock.timers.reset();
    }
  });

  test('one-call API login path and step-up enforce per-user lockout, do not leak upstream sessions, and ignore discovery calls', async () => {
    testMock.timers.enable({ apis: ['Date'], now: 1_700_200_000_000 });
    try {
      const { baseUrl, secret, recoveryCodes, jar } = await setupUserWithTotp({
        require2fa: true,
        trustProxy: 1,
      });
      const sessionsBefore = joplinMock.sessions.size;

      // API discovery calls (no totpCode/recoveryCode) never count toward lockout
      for (let i = 0; i < 6; i++) {
        const disc = await call(baseUrl, '/api/auth/login', {
          method: 'POST',
          headers: { 'X-Forwarded-For': `10.1.0.${i + 1}` },
          json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
        });
        assert.equal(disc.status, 401);
        assert.equal(disc.data.twoFactor?.required, true);
      }

      // 5 failed second-factor guesses via API login (4 wrong TOTP + 1 wrong recovery) trigger 1-min lockout
      for (let i = 0; i < 4; i++) {
        const failTotp = await call(baseUrl, '/api/auth/login', {
          method: 'POST',
          headers: { 'X-Forwarded-For': `10.1.1.${i + 1}` },
          json: { email: DEMO_EMAIL, password: DEMO_PASSWORD, totpCode: '000000' },
        });
        assert.equal(failTotp.status, 401);
      }
      const failRec = await call(baseUrl, '/api/auth/login', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '10.1.1.5' },
        json: { email: DEMO_EMAIL, password: DEMO_PASSWORD, recoveryCode: 'BBBB-BBBB-BBBB-BBBB' },
      });
      assert.equal(failRec.status, 401);

      // While locked: API discovery still returns 401 twoFactor required; API verify calls return 429 & clean upstream sessions
      const discWhileLocked = await call(baseUrl, '/api/auth/login', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '10.1.2.1' },
        json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
      });
      assert.equal(discWhileLocked.status, 401);

      const apiLockedTotp = await call(baseUrl, '/api/auth/login', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '10.1.2.2' },
        json: { email: DEMO_EMAIL, password: DEMO_PASSWORD, totpCode: computeTotp(secret, Date.now()) },
      });
      assert.equal(apiLockedTotp.status, 429);
      assert.ok(apiLockedTotp.data.retryAfter > 0 && apiLockedTotp.data.retryAfter <= 60);
      assert.equal(Number(apiLockedTotp.headers.get('retry-after')), apiLockedTotp.data.retryAfter);

      const apiLockedRec = await call(baseUrl, '/api/auth/login', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '10.1.2.3' },
        json: { email: DEMO_EMAIL, password: DEMO_PASSWORD, recoveryCode: recoveryCodes[0] },
      });
      assert.equal(apiLockedRec.status, 429);
      assert.equal(joplinMock.sessions.size, sessionsBefore, 'locked API logins must close temporary upstream sessions');

      // Advance past lock -> valid API TOTP login succeeds and resets lockout
      testMock.timers.setTime(Date.now() + 61_000);
      const apiOk = await call(baseUrl, '/api/auth/login', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '10.1.2.4' },
        json: { email: DEMO_EMAIL, password: DEMO_PASSWORD, totpCode: computeTotp(secret, Date.now()) },
      });
      assert.equal(apiOk.status, 200);
      assert.ok(apiOk.data.sessionId);

      // Step-up failure lockout: 5 wrong step-up checks return 400, 6th returns 429
      for (let i = 0; i < 5; i++) {
        const failStep = await call(baseUrl, '/api/auth/2fa/step-up/totp', {
          method: 'POST',
          headers: { Origin: baseUrl, 'X-Forwarded-For': `10.1.3.${i + 1}` },
          jar,
          json: { code: '000000' },
        });
        assert.equal(failStep.status, 400);
      }
      const lockedStep = await call(baseUrl, '/api/auth/2fa/step-up/recovery', {
        method: 'POST',
        headers: { Origin: baseUrl, 'X-Forwarded-For': '10.1.3.6' },
        jar,
        json: { code: recoveryCodes[0] },
      });
      assert.equal(lockedStep.status, 429);
      assert.ok(lockedStep.data.retryAfter > 0 && lockedStep.data.retryAfter <= 60);
    } finally {
      testMock.timers.reset();
    }
  });
});
