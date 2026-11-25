export class AuthRequiredError extends Error {
  constructor(message = 'Not signed in to Joplin Web') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

export class OriginRejectedError extends Error {
  constructor(extensionId) {
    super(
      `Server rejected the extension's origin. Set CLIPPER_EXTENSION_IDS=${extensionId} on the Joplin Web server.`
    );
    this.name = 'OriginRejectedError';
    this.extensionId = extensionId;
  }
}

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function normalizeServerUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Enter a valid URL starting with http:// or https://');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Server URL must start with http:// or https://');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Server URL must not contain credentials');
  }
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
}

export async function getServerUrl() {
  const data = await chrome.storage.sync.get({ serverUrl: '' });
  return typeof data.serverUrl === 'string' ? data.serverUrl.trim().replace(/\/+$/, '') : '';
}

export async function setServerUrl(url) {
  const normalized = normalizeServerUrl(url);
  await chrome.storage.sync.set({ serverUrl: normalized });
  return normalized;
}

export async function getPreferences() {
  const data = await chrome.storage.local.get({ lastNotebookId: '', lastMode: 'article' });
  return {
    lastNotebookId: typeof data.lastNotebookId === 'string' ? data.lastNotebookId : '',
    lastMode: typeof data.lastMode === 'string' ? data.lastMode : 'article',
  };
}

export async function savePreferences(partial) {
  const toSave = {};
  if (typeof partial.lastNotebookId === 'string') toSave.lastNotebookId = partial.lastNotebookId;
  if (typeof partial.lastMode === 'string') toSave.lastMode = partial.lastMode;
  if (Object.keys(toSave).length > 0) {
    await chrome.storage.local.set(toSave);
  }
}

function isRedirectOrHtmlAuthWall(res) {
  if (res.type === 'opaqueredirect') return true;
  if (res.status >= 300 && res.status < 400) return true;
  if (res.status === 401) return true;
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/html')) return true;
  return false;
}

async function parseJsonSafe(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function apiFetch(serverUrl, path, init = {}) {
  let res;
  try {
    res = await fetch(`${serverUrl}${path}`, {
      ...init,
      credentials: 'include',
      redirect: 'manual',
    });
  } catch {
    throw new ApiError(`Could not reach ${serverUrl}. Check the server URL and your connection.`, 0);
  }

  if (isRedirectOrHtmlAuthWall(res)) {
    throw new AuthRequiredError(`Not signed in: open ${serverUrl} and sign in`);
  }

  const data = await parseJsonSafe(res);
  if (res.status === 403 && data && typeof data.error === 'string' && /origin/i.test(data.error)) {
    throw new OriginRejectedError(chrome.runtime.id);
  }

  if (!res.ok) {
    const msg =
      (data && typeof data.error === 'string' && data.error) ||
      `Server returned HTTP ${res.status}`;
    throw new ApiError(msg, res.status);
  }

  if (data === null) {
    throw new AuthRequiredError(`Unexpected non-JSON response from ${serverUrl}. Open it and sign in.`);
  }

  return data;
}

export async function checkAuth(serverUrl) {
  const data = await apiFetch(serverUrl, '/api/auth/check', { method: 'GET' });
  if (!data || data.valid !== true) {
    throw new AuthRequiredError(`Not signed in: open ${serverUrl} and sign in`);
  }
  return data;
}

/**
 * Verifies connectivity, session auth, and whether the server allows POST requests from this
 * extension's chrome-extension:// origin (CLIPPER_EXTENSION_IDS).
 */
export async function testConnection(serverUrl) {
  const extId = chrome.runtime.id;
  let authData;
  try {
    authData = await checkAuth(serverUrl);
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      return {
        status: 'unauthenticated',
        message: `Not signed in: open ${serverUrl} and sign in`,
      };
    }
    return {
      status: 'error',
      message: err instanceof Error ? err.message : 'Connection failed',
    };
  }

  // Send a harmless empty POST to /api/clip/html so the server's origin check runs.
  // Allowed origin -> 400 (validation error, no note created). Rejected origin -> 403.
  let probeRes;
  try {
    probeRes = await fetch(`${serverUrl}/api/clip/html`, {
      method: 'POST',
      credentials: 'include',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  } catch {
    return {
      status: 'error',
      message: `Could not reach ${serverUrl} to verify write access.`,
    };
  }

  if (isRedirectOrHtmlAuthWall(probeRes)) {
    return {
      status: 'unauthenticated',
      message: `Not signed in: open ${serverUrl} and sign in`,
    };
  }

  const probeData = await parseJsonSafe(probeRes);
  if (probeRes.status === 403) {
    return {
      status: 'origin_rejected',
      message: `Server rejected the extension's origin: set CLIPPER_EXTENSION_IDS=${extId}`,
    };
  }
  if (probeRes.status === 404) {
    return {
      status: 'error',
      message: 'This Joplin Web server does not support POST /api/clip/html yet. Please update the server.',
    };
  }
  if (probeRes.status === 400 || probeRes.ok) {
    const hostLabel = authData.serverHost || new URL(serverUrl).host;
    return {
      status: 'ok',
      serverHost: hostLabel,
      message: `Signed in (Joplin Server: ${hostLabel})`,
    };
  }

  return {
    status: 'error',
    message: (probeData && probeData.error) || `Unexpected response (HTTP ${probeRes.status})`,
  };
}

export async function fetchNotebooks(serverUrl) {
  return apiFetch(serverUrl, '/api/notebooks', { method: 'GET' });
}

export async function fetchTags(serverUrl) {
  return apiFetch(serverUrl, '/api/tags', { method: 'GET' });
}

export async function uploadResource(serverUrl, { name, mime, data }) {
  return apiFetch(serverUrl, '/api/resources', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(name),
      'X-File-Type': mime,
    },
    body: data,
  });
}

export async function clipHtml(serverUrl, payload) {
  return apiFetch(serverUrl, '/api/clip/html', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function clipUrl(serverUrl, payload) {
  return apiFetch(serverUrl, '/api/clip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function flattenWritableNotebooks(notebooks, depth = 0, out = []) {
  if (!Array.isArray(notebooks)) return out;
  for (const nb of notebooks) {
    if (!nb.encrypted) {
      out.push({ id: nb.id, title: nb.title, depth });
    }
    if (Array.isArray(nb.children) && nb.children.length > 0) {
      flattenWritableNotebooks(nb.children, depth + 1, out);
    }
  }
  return out;
}

export function findDefaultNotebookId(flatWritable, lastNotebookId) {
  if (!Array.isArray(flatWritable) || flatWritable.length === 0) return '';
  if (lastNotebookId && flatWritable.some((nb) => nb.id === lastNotebookId)) {
    return lastNotebookId;
  }
  const lower = (s) => String(s || '').trim().toLowerCase();
  const inbox =
    flatWritable.find((nb) => lower(nb.title) === 'inbox') ||
    flatWritable.find((nb) => lower(nb.title) === 'pending to sort');
  return (inbox && inbox.id) || flatWritable[0].id;
}
