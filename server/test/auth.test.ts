import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import type { AppConfig } from '../src/config.js';
import { startMockJoplinServer, type MockJoplinServer } from '../demo/mock-joplin-server.js';
import { buildDemoItems, DEMO_EMAIL, DEMO_PASSWORD } from '../demo/seed.js';

/**
 * Session cookie, CSRF/origin checks, logout, proxy and CSP configuration, against the mock Joplin
 * Server. Each test builds its own app with createApp(), so configurations don't affect each other.
 */

let mock: MockJoplinServer;
let baseConfig: AppConfig;
let createApp: typeof import('../src/app.js').createApp;
const servers: Server[] = [];

before(async () => {
  mock = await startMockJoplinServer({ email: DEMO_EMAIL, password: DEMO_PASSWORD, items: buildDemoItems() });
  // Must be set before the backend's config module is loaded
  process.env.JOPLIN_SERVER_URL = mock.url;
  process.env.CACHE_TTL_MS = '0';
  const { loadConfig } = await import('../src/config.js');
  ({ createApp } = await import('../src/app.js'));
  baseConfig = { ...loadConfig(), clientDistPath: '/nonexistent', corsOrigin: 'http://localhost:5173' };
});

after(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await mock.close();
});

/** Starts an app with the given config overrides and returns its base URL */
async function startApp(overrides: Partial<AppConfig> = {}): Promise<string> {
  const app = createApp({ ...baseConfig, ...overrides });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function call(baseUrl: string, path: string, init: RequestInit & { json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers, body, redirect: 'manual' });
  const text = await res.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }
  return { status: res.status, data, headers: res.headers };
}

/** Logs in like the browser client (with an Origin header) and returns the cookie pair to send back */
async function browserLogin(baseUrl: string): Promise<{ cookie: string; setCookie: string; data: any }> {
  const res = await call(baseUrl, '/api/auth/login', {
    method: 'POST',
    headers: { Origin: baseUrl },
    json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
  });
  assert.equal(res.status, 200);
  const setCookie = sessionSetCookie(res.headers);
  return { cookie: setCookie.split(';')[0], setCookie, data: res.data };
}

/** The Set-Cookie header that sets (not clears) a session cookie */
function sessionSetCookie(headers: Headers): string {
  const setCookie = headers.getSetCookie().find((c) => /^(__Host-)?joplin_web_session=[^;]+/.test(c));
  assert.ok(setCookie, 'session cookie is set');
  return setCookie;
}

describe('session cookie', () => {
  test('browser login sets an httpOnly SameSite=Strict cookie and keeps the token out of the body', async () => {
    const baseUrl = await startApp();
    const { cookie, setCookie, data } = await browserLogin(baseUrl);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(setCookie, /^joplin_web_session=/);
    assert.match(setCookie, /Path=\/api/i);
    assert.doesNotMatch(setCookie, /Secure/i, 'no Secure flag over plain HTTP');
    assert.equal(data.sessionId, undefined);

    const check = await call(baseUrl, '/api/auth/check', { headers: { Cookie: cookie } });
    assert.equal(check.status, 200);
    assert.deepEqual(Object.keys(check.data).sort(), ['serverHost', 'valid'], 'check never echoes the token');
    assert.equal(check.data.valid, true);
    assert.equal((await call(baseUrl, '/api/notebooks', { headers: { Cookie: cookie } })).status, 200);
  });

  test('API clients without an Origin header still get the token for Bearer auth', async () => {
    const baseUrl = await startApp();
    const res = await call(baseUrl, '/api/auth/login', { method: 'POST', json: { email: DEMO_EMAIL, password: DEMO_PASSWORD } });
    assert.equal(res.status, 200);
    assert.ok(res.data.sessionId);
    const check = await call(baseUrl, '/api/auth/check', { headers: { Authorization: `Bearer ${res.data.sessionId}` } });
    assert.equal(check.status, 200);
  });

  test('wrong credentials give the login error message', async () => {
    const baseUrl = await startApp();
    const res = await call(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { Origin: baseUrl },
      json: { email: DEMO_EMAIL, password: 'wrong' },
    });
    assert.equal(res.status, 401);
    assert.deepEqual(res.data, { error: 'Invalid email or password' });
    assert.equal(res.headers.getSetCookie().length, 0);
  });

  test('rejects non-string credentials', async () => {
    const baseUrl = await startApp();
    const res = await call(baseUrl, '/api/auth/login', { method: 'POST', json: { email: [DEMO_EMAIL], password: {} } });
    assert.equal(res.status, 400);
  });

  test('uses a Secure __Host- cookie when configured or when a trusted proxy reports HTTPS', async () => {
    const forced = await startApp({ cookieSecure: true });
    const { setCookie, cookie } = await browserLogin(forced);
    assert.match(setCookie, /^__Host-joplin_web_session=/);
    assert.match(setCookie, /;\s*Secure/i);
    assert.match(setCookie, /Path=\/;/i);
    assert.doesNotMatch(setCookie, /Domain=/i);
    assert.equal((await call(forced, '/api/auth/check', { headers: { Cookie: cookie } })).status, 200);

    const proxied = await startApp({ trustProxy: 1 });
    const res = await call(proxied, '/api/auth/login', {
      method: 'POST',
      headers: { Origin: proxied, 'X-Forwarded-Proto': 'https' },
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });
    assert.match(sessionSetCookie(res.headers), /^__Host-.*;\s*Secure/i);

    // Without TRUST_PROXY, a forwarded protocol header is ignored
    const direct = await startApp();
    const directRes = await call(direct, '/api/auth/login', {
      method: 'POST',
      headers: { Origin: direct, 'X-Forwarded-Proto': 'https' },
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });
    assert.doesNotMatch(sessionSetCookie(directRes.headers), /Secure/i);
  });

  test('rejects requests with more than one session cookie', async () => {
    const baseUrl = await startApp();
    const { cookie } = await browserLogin(baseUrl);
    // Another app on the same host planted a cookie with a longer path, which the browser sends first
    const planted = `joplin_web_session=attackersession; ${cookie}`;
    assert.equal((await call(baseUrl, '/api/auth/check', { headers: { Cookie: planted } })).status, 401);
    const mixed = `__Host-joplin_web_session=attackersession; ${cookie}`;
    assert.equal((await call(baseUrl, '/api/notebooks', { headers: { Cookie: mixed } })).status, 401);
    assert.equal((await call(baseUrl, '/api/auth/check', { headers: { Cookie: cookie } })).status, 200);
  });
});

describe('CSRF protection', () => {
  const newNotebook = (baseUrl: string, headers: Record<string, string>) =>
    call(baseUrl, '/api/notebooks', { method: 'POST', headers, json: { title: 'CSRF probe' } });

  test('accepts cookie writes from the app origin', async () => {
    const baseUrl = await startApp();
    const { cookie } = await browserLogin(baseUrl);
    assert.equal((await newNotebook(baseUrl, { Cookie: cookie, Origin: baseUrl })).status, 201);
  });

  test('rejects cookie writes from other origins, from null origins and without an origin', async () => {
    const baseUrl = await startApp();
    const { cookie } = await browserLogin(baseUrl);
    assert.equal((await newNotebook(baseUrl, { Cookie: cookie, Origin: 'https://evil.example' })).status, 403);
    assert.equal((await newNotebook(baseUrl, { Cookie: cookie, Origin: 'null' })).status, 403);
    assert.equal((await newNotebook(baseUrl, { Cookie: cookie })).status, 403);
    const logout = await call(baseUrl, '/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example' } });
    assert.equal(logout.status, 403);
    // Reads are not affected
    assert.equal((await call(baseUrl, '/api/notebooks', { headers: { Cookie: cookie } })).status, 200);
  });

  test('rejects cross-site login attempts', async () => {
    const baseUrl = await startApp();
    const res = await call(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });
    assert.equal(res.status, 403);
  });

  test('accepts the origin from X-Forwarded-Host, PUBLIC_URL and CORS_ORIGIN', async () => {
    const baseUrl = await startApp({ publicUrl: 'https://notes-web.example.com' });
    const { cookie } = await browserLogin(baseUrl);
    const viaProxy = { Cookie: cookie, Origin: 'https://proxy.example.com', 'X-Forwarded-Host': 'proxy.example.com' };
    assert.equal((await newNotebook(baseUrl, viaProxy)).status, 201);
    assert.equal((await newNotebook(baseUrl, { Cookie: cookie, Origin: 'https://notes-web.example.com' })).status, 201);
    assert.equal((await newNotebook(baseUrl, { Cookie: cookie, Origin: 'http://localhost:5173' })).status, 201);
  });

  test('header-authenticated API clients need no origin', async () => {
    const baseUrl = await startApp();
    const login = await call(baseUrl, '/api/auth/login', { method: 'POST', json: { email: DEMO_EMAIL, password: DEMO_PASSWORD } });
    assert.equal((await newNotebook(baseUrl, { Authorization: `Bearer ${login.data.sessionId}` })).status, 201);
  });
});

describe('logout', () => {
  test('ends the session locally and on Joplin Server and clears the cookie', async () => {
    const baseUrl = await startApp();
    const { cookie } = await browserLogin(baseUrl);
    const token = decodeURIComponent(cookie.split('=')[1]);
    // Warm the validation and note caches
    assert.equal((await call(baseUrl, '/api/notebooks', { headers: { Cookie: cookie } })).status, 200);

    const res = await call(baseUrl, '/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: baseUrl } });
    assert.equal(res.status, 200);
    const cleared = res.headers.getSetCookie().find((c) => c.startsWith('joplin_web_session=;'));
    assert.ok(cleared, 'cookie is cleared');
    assert.match(cleared, /Expires=Thu, 01 Jan 1970/i);

    // Rejected by Joplin Web despite the warm cache ...
    assert.equal((await call(baseUrl, '/api/auth/check', { headers: { Cookie: cookie } })).status, 401);
    assert.equal((await call(baseUrl, '/api/notebooks', { headers: { Authorization: `Bearer ${token}` } })).status, 401);
    // ... and by Joplin Server itself (a fresh Joplin Web instance has a cold validation cache)
    const upstream = await fetch(`${mock.url}/api/items/root:/:/children`, { headers: { 'X-API-AUTH': token } });
    assert.equal(upstream.status, 403);
  });

  test('ends a Bearer session too', async () => {
    const baseUrl = await startApp();
    const login = await call(baseUrl, '/api/auth/login', { method: 'POST', json: { email: DEMO_EMAIL, password: DEMO_PASSWORD } });
    const auth = { Authorization: `Bearer ${login.data.sessionId}` };
    assert.equal((await call(baseUrl, '/api/auth/check', { headers: auth })).status, 200);
    assert.equal((await call(baseUrl, '/api/auth/logout', { method: 'POST', headers: auth })).status, 200);
    assert.equal((await call(baseUrl, '/api/auth/check', { headers: auth })).status, 401);
  });

  test('reports an unreachable Joplin Server and still logs out unknown sessions', async () => {
    const { JoplinApiService } = await import('../src/services/joplin-api.js');
    const unreachable = new JoplinApiService('http://127.0.0.1:1');
    await assert.rejects(unreachable.deleteSession('x'));

    const baseUrl = await startApp();
    // Unknown sessions are ignored by Joplin Server; logout must not fail
    const res = await call(baseUrl, '/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer not-a-session' } });
    assert.equal(res.status, 200);
    // Malformed tokens are neither cached nor sent upstream, but logout still answers normally
    const long = await call(baseUrl, '/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${'x'.repeat(5000)}` } });
    assert.equal(long.status, 200);
  });

  test('only a redirect to /login counts as an ended Joplin Server session', async () => {
    const { JoplinApiService } = await import('../src/services/joplin-api.js');
    const express = (await import('express')).default;
    let reply: (res: import('express').Response) => void = () => undefined;
    const stub = express();
    const stubServer: Server = await new Promise((resolve) => {
      const s = stub.listen(0, '127.0.0.1', () => resolve(s));
    });
    servers.push(stubServer);
    const api = new JoplinApiService(`http://127.0.0.1:${(stubServer.address() as AddressInfo).port}/joplin`);
    stub.post('/joplin/logout', (_req, res) => reply(res));

    reply = (res) => res.redirect(302, '/joplin/login');
    await api.deleteSession('token');
    reply = (res) => res.redirect(302, 'https://notes.example.com/joplin/login');
    await api.deleteSession('token');

    reply = (res) => res.status(200).send('<html>ok?</html>');
    await assert.rejects(api.deleteSession('token'), /Unexpected logout response/);
    reply = (res) => res.redirect(301, 'https://127.0.0.1/joplin/logout');
    await assert.rejects(api.deleteSession('token'), /Unexpected logout response/);
    reply = (res) => res.status(403).send('<html>Forbidden</html>');
    await assert.rejects(api.deleteSession('token'));
  });
});

describe('reverse proxy', () => {
  const failedLogin = (baseUrl: string, ip: string) =>
    call(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { 'X-Forwarded-For': ip },
      json: { email: DEMO_EMAIL, password: 'wrong' },
    });

  test('with TRUST_PROXY the login limiter counts each forwarded client separately', async () => {
    const baseUrl = await startApp({ trustProxy: 1 });
    for (let i = 0; i < 30; i++) assert.equal((await failedLogin(baseUrl, '203.0.113.1')).status, 401);
    assert.equal((await failedLogin(baseUrl, '203.0.113.1')).status, 429);
    assert.equal((await failedLogin(baseUrl, '203.0.113.2')).status, 401, 'other clients are not locked out');
  });

  test('without TRUST_PROXY forwarded addresses are ignored', async () => {
    const baseUrl = await startApp();
    for (let i = 0; i < 30; i++) await failedLogin(baseUrl, `203.0.113.${i + 10}`);
    assert.equal((await failedLogin(baseUrl, '203.0.113.99')).status, 429, 'spoofed X-Forwarded-For does not bypass the limit');
  });

  test('parses TRUST_PROXY', async () => {
    const { parseTrustProxy, ConfigError } = await import('../src/config.js');
    assert.equal(parseTrustProxy(undefined), false);
    assert.equal(parseTrustProxy('false'), false);
    assert.equal(parseTrustProxy('0'), false);
    assert.equal(parseTrustProxy('true'), true);
    assert.equal(parseTrustProxy('2'), 2);
    assert.deepEqual(parseTrustProxy('loopback, 10.0.0.0/8'), ['loopback', '10.0.0.0/8']);
    assert.throws(() => parseTrustProxy('yes please'), ConfigError);
  });
});

describe('content security policy', () => {
  const csp = async (overrides: Partial<AppConfig>) => {
    const res = await call(await startApp(overrides), '/api/health');
    return res.headers.get('content-security-policy') ?? '';
  };

  test('defaults work over plain HTTP and block remote images', async () => {
    const policy = await csp({});
    assert.doesNotMatch(policy, /upgrade-insecure-requests/);
    assert.match(policy, /img-src 'self' data: blob:;/);
    assert.match(policy, /script-src 'self';/);
    assert.doesNotMatch(policy, /unsafe-inline'[^;]*;?\s*script-src|script-src[^;]*unsafe-inline/);
  });

  test('upgrades insecure requests when PUBLIC_URL is https', async () => {
    assert.match(await csp({ publicUrl: 'https://notes-web.example.com' }), /upgrade-insecure-requests/);
  });

  test('ALLOW_REMOTE_IMAGES allows https: images only', async () => {
    assert.match(await csp({ allowRemoteImages: true }), /img-src 'self' data: blob: https:;/);
  });

  test('parses the CSP and cookie settings from the environment', async () => {
    const { loadConfig, ConfigError } = await import('../src/config.js');
    const env = { JOPLIN_SERVER_URL: 'https://notes.example.com' };
    const defaults = loadConfig(env);
    assert.equal(defaults.allowRemoteImages, false);
    assert.equal(defaults.publicUrl, null);
    assert.equal(defaults.cookieSecure, 'auto');
    assert.equal(loadConfig({ ...env, ALLOW_REMOTE_IMAGES: 'true' }).allowRemoteImages, true);
    assert.equal(loadConfig({ ...env, PUBLIC_URL: 'https://web.example.com/app/' }).publicUrl, 'https://web.example.com');
    assert.equal(loadConfig({ ...env, COOKIE_SECURE: 'false' }).cookieSecure, false);
    assert.throws(() => loadConfig({ ...env, ALLOW_REMOTE_IMAGES: 'maybe' }), ConfigError);
    assert.throws(() => loadConfig({ ...env, PUBLIC_URL: 'javascript:alert(1)' }), ConfigError);
  });
});

describe('ids', () => {
  test('new items get 32-character hex ids', async () => {
    const baseUrl = await startApp();
    const login = await call(baseUrl, '/api/auth/login', { method: 'POST', json: { email: DEMO_EMAIL, password: DEMO_PASSWORD } });
    const res = await call(baseUrl, '/api/notebooks', {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.data.sessionId}` },
      json: { title: 'Id format' },
    });
    assert.equal(res.status, 201);
    assert.match(res.data.id, /^[0-9a-f]{32}$/);
  });
});
