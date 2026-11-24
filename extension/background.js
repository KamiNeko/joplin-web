import {
  AuthRequiredError,
  OriginRejectedError,
  clipHtml,
  clipUrl,
  getPreferences,
  getServerUrl,
  savePreferences,
  uploadResource,
} from './lib/api.js';

const MAX_IMAGES_PER_CLIP = 50;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const UPLOAD_CONCURRENCY = 4;

const MENU_CLIP_SELECTION = 'joplin-clip-selection';
const MENU_SAVE_IMAGE = 'joplin-save-image';
const MENU_CLIP_LINK = 'joplin-clip-link';

const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};

function detectImageMime(bytes) {
  if (bytes.length >= 4) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
    if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) return 'image/x-icon';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'image/bmp';
  }
  if (bytes.length >= 12) {
    const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    const webp = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
    const ftyp = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (ftyp === 'ftyp' && (brand === 'avif' || brand === 'avis')) return 'image/avif';
  }
  try {
    const head = new TextDecoder().decode(bytes.subarray(0, 256)).trim().toLowerCase();
    if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
      return 'image/svg+xml';
    }
  } catch {
    // ignore decode errors
  }
  return null;
}

function filenameForImage(url, mime, fallbackBase = 'image') {
  const ext = EXT_BY_MIME[mime] || 'png';
  if (url && !url.startsWith('data:')) {
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname.split('/').filter(Boolean);
      let base = segments.length > 0 ? segments[segments.length - 1] : '';
      try {
        base = decodeURIComponent(base);
      } catch {
        // keep raw
      }
      base = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 120);
      if (base) {
        return /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}.${ext}`;
      }
    } catch {
      // fall through
    }
  }
  return `${fallbackBase}.${ext}`;
}

function decodeDataUri(dataUri) {
  const comma = dataUri.indexOf(',');
  if (comma === -1) throw new Error('Invalid data URI');
  const header = dataUri.slice(5, comma);
  const payload = dataUri.slice(comma + 1);
  const isBase64 = /;base64$/i.test(header) || header.toLowerCase().includes(';base64;');
  const mime = (header.split(';')[0] || '').trim().toLowerCase() || 'application/octet-stream';

  let bytes;
  if (isBase64) {
    const binary = atob(payload.replace(/\s+/g, ''));
    if (binary.length > MAX_IMAGE_BYTES) throw new Error('Image exceeds 10 MB limit');
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } else {
    const decoded = decodeURIComponent(payload);
    bytes = new TextEncoder().encode(decoded);
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error('Image size out of range');
  }
  const detected = mime.startsWith('image/') ? mime : detectImageMime(bytes);
  if (!detected || !detected.startsWith('image/')) {
    throw new Error('Data URI is not an image');
  }
  return {
    data: bytes,
    mime: detected,
    name: filenameForImage('', detected, 'embedded-image'),
  };
}

async function fetchImagePayload(url) {
  if (url.startsWith('data:')) {
    return decodeDataUri(url);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, { credentials: 'include', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const lenHeader = res.headers.get('content-length');
    if (lenHeader && Number(lenHeader) > MAX_IMAGE_BYTES) {
      throw new Error('Image exceeds 10 MB limit');
    }
    const rawType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (rawType && !rawType.startsWith('image/') && rawType !== 'application/octet-stream') {
      throw new Error(`Not an image (${rawType})`);
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) {
      throw new Error('Image size out of range');
    }
    const bytes = new Uint8Array(buf);
    const mime = rawType.startsWith('image/') ? rawType : detectImageMime(bytes);
    if (!mime || !mime.startsWith('image/')) {
      throw new Error('Unrecognized image format');
    }
    return {
      data: bytes,
      mime,
      name: filenameForImage(url, mime),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function uploadCapturedImages(serverUrl, images, onProgress) {
  const list = Array.isArray(images) ? images : [];
  if (list.length === 0) {
    return { tokenToResourceId: new Map(), skippedImages: 0, uploadedImages: 0 };
  }

  const toProcess = list.slice(0, MAX_IMAGES_PER_CLIP);
  let skippedImages = Math.max(0, list.length - toProcess.length);
  let uploadedImages = 0;
  let completed = 0;
  const tokenToResourceId = new Map();

  let next = 0;
  const worker = async () => {
    while (next < toProcess.length) {
      const item = toProcess[next++];
      let payload;
      try {
        payload = await fetchImagePayload(item.url);
      } catch {
        skippedImages++;
        completed++;
        onProgress?.(completed, toProcess.length);
        continue;
      }

      try {
        const resource = await uploadResource(serverUrl, payload);
        tokenToResourceId.set(item.token, resource.id);
        uploadedImages++;
      } catch (err) {
        if (err instanceof AuthRequiredError || err instanceof OriginRejectedError) {
          throw err;
        }
        skippedImages++;
      }
      completed++;
      onProgress?.(completed, toProcess.length);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, toProcess.length) }, worker)
  );

  return { tokenToResourceId, skippedImages, uploadedImages };
}

function replaceImageTokens(html, images, tokenToResourceId) {
  let result = html;
  for (const img of images || []) {
    const resourceId = tokenToResourceId.get(img.token);
    if (resourceId) {
      result = result.split(img.token).join(`:/${resourceId}`);
    } else if (img.url && !img.url.startsWith('data:')) {
      const safe = img.url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      result = result.split(img.token).join(safe);
    } else {
      // Avoid embedding an oversized/failed data: URI into the JSON payload
      result = result.split(img.token).join('');
    }
  }
  return result;
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function captureInTab(tabId, mode) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['vendor/Readability.js', 'capture.js'],
  });
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (m) => globalThis.__joplinClipperCapture(m),
    args: [mode],
  });
  const first = results && results[0];
  if (!first || !first.result) {
    throw new Error('Could not capture this page. Chrome internal pages cannot be clipped.');
  }
  return first.result;
}

export async function performClip({ tabId, mode, title, parentId, tags, serverUrl: explicitServerUrl, onProgress }) {
  const serverUrl = explicitServerUrl || (await getServerUrl());
  if (!serverUrl) {
    throw new Error('No Joplin Web server URL configured. Open extension options to set it.');
  }

  const tab = await chrome.tabs.get(tabId);
  if (!tab || !tab.url || !/^https?:\/\//i.test(tab.url)) {
    throw new Error('Only http:// and https:// pages can be clipped.');
  }

  if (mode === 'screenshot') {
    onProgress?.('Capturing visible tab…');
    let previousActiveTabId = null;
    if (!tab.active) {
      const activeTabs = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      if (activeTabs[0] && activeTabs[0].id !== tabId) {
        previousActiveTabId = activeTabs[0].id;
      }
      await chrome.tabs.update(tabId, { active: true });
      await new Promise((r) => setTimeout(r, 150));
    }
    let dataUrl;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    } finally {
      if (previousActiveTabId !== null) {
        await chrome.tabs.update(previousActiveTabId, { active: true }).catch(() => {});
      }
    }
    const payload = decodeDataUri(dataUrl);
    payload.name = `screenshot-${Date.now()}.png`;
    onProgress?.('Uploading screenshot…');
    const resource = await uploadResource(serverUrl, payload);
    const noteTitle = (title && title.trim()) || tab.title || new URL(tab.url).hostname;
    const html = `<p><img src=":/${resource.id}" alt="${escapeHtml(noteTitle)}"></p><p><a href="${escapeHtml(tab.url)}">${escapeHtml(tab.url)}</a></p>`;
    onProgress?.('Saving note…');
    const res = await clipHtml(serverUrl, {
      url: tab.url,
      title: noteTitle,
      html,
      format: 'markdown',
      ...(parentId ? { parentId } : {}),
      ...(Array.isArray(tags) && tags.length > 0 ? { tags } : {}),
    });
    await savePreferences({ lastNotebookId: parentId || res.note.parentId || '', lastMode: mode });
    return { note: res.note, uploadedImages: 1, skippedImages: 0 };
  }

  onProgress?.('Capturing page…');
  const captured = await captureInTab(tabId, mode);
  const noteTitle = (title && title.trim()) || captured.title;

  const totalImgs = Math.min((captured.images || []).length, MAX_IMAGES_PER_CLIP);
  if (totalImgs > 0) {
    onProgress?.(`Uploading images (0/${totalImgs})…`);
  }
  const { tokenToResourceId, skippedImages, uploadedImages } = await uploadCapturedImages(
    serverUrl,
    captured.images,
    (done, total) => onProgress?.(`Uploading images (${done}/${total})…`)
  );

  const rewrittenHtml = replaceImageTokens(captured.html, captured.images, tokenToResourceId);
  onProgress?.('Saving note…');
  const res = await clipHtml(serverUrl, {
    url: captured.url,
    title: noteTitle,
    html: rewrittenHtml,
    format: captured.format,
    ...(parentId ? { parentId } : {}),
    ...(Array.isArray(tags) && tags.length > 0 ? { tags } : {}),
    ...(captured.byline ? { byline: captured.byline } : {}),
    ...(captured.siteName ? { siteName: captured.siteName } : {}),
  });

  await savePreferences({ lastNotebookId: parentId || res.note.parentId || '', lastMode: mode });
  return { note: res.note, uploadedImages, skippedImages };
}

async function saveSingleImage({ imageUrl, pageUrl, pageTitle, parentId, serverUrl }) {
  const payload = await fetchImagePayload(imageUrl);
  const resource = await uploadResource(serverUrl, payload);
  const sourceUrl = pageUrl && /^https?:\/\//i.test(pageUrl) ? pageUrl : imageUrl;
  const noteTitle = pageTitle ? `Image from ${pageTitle}` : payload.name;
  const html = `<p><img src=":/${resource.id}" alt="${escapeHtml(payload.name)}"></p><p><a href="${escapeHtml(sourceUrl)}">${escapeHtml(sourceUrl)}</a></p>`;
  const res = await clipHtml(serverUrl, {
    url: sourceUrl,
    title: noteTitle,
    html,
    format: 'markdown',
    ...(parentId ? { parentId } : {}),
  });
  return res.note;
}

async function flashBadge(text, color, title) {
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
    if (title) await chrome.action.setTitle({ title });
    setTimeout(() => {
      chrome.action.setBadgeText({ text: '' }).catch(() => {});
      chrome.action.setTitle({ title: 'Clip to Joplin Web' }).catch(() => {});
    }, 4500);
  } catch {
    // ignore badge errors
  }
}

function registerContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_CLIP_SELECTION,
      title: 'Clip selection to Joplin Web',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: MENU_SAVE_IMAGE,
      title: 'Save image to Joplin Web',
      contexts: ['image'],
    });
    chrome.contextMenus.create({
      id: MENU_CLIP_LINK,
      title: 'Clip link to Joplin Web',
      contexts: ['link'],
    });
  });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  registerContextMenus();
  if (details.reason === 'install') {
    const serverUrl = await getServerUrl();
    if (!serverUrl) {
      chrome.runtime.openOptionsPage();
    }
  }
});

chrome.runtime.onStartup.addListener(() => {
  registerContextMenus();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const serverUrl = await getServerUrl();
  if (!serverUrl) {
    await flashBadge('!', '#dc2626', 'Set your Joplin Web server URL in extension options');
    chrome.runtime.openOptionsPage();
    return;
  }

  const { lastNotebookId } = await getPreferences();
  const parentId = lastNotebookId || undefined;

  try {
    await flashBadge('…', '#1071e5', 'Clipping to Joplin Web…');
    if (info.menuItemId === MENU_CLIP_SELECTION && tab && typeof tab.id === 'number') {
      const result = await performClip({
        tabId: tab.id,
        mode: 'selection',
        parentId,
        serverUrl,
      });
      await flashBadge('OK', '#16a34a', `Clipped "${result.note.title}" to Joplin Web`);
    } else if (info.menuItemId === MENU_SAVE_IMAGE && info.srcUrl) {
      const note = await saveSingleImage({
        imageUrl: info.srcUrl,
        pageUrl: info.pageUrl || (tab && tab.url) || '',
        pageTitle: (tab && tab.title) || '',
        parentId,
        serverUrl,
      });
      await flashBadge('OK', '#16a34a', `Saved image "${note.title}" to Joplin Web`);
    } else if (info.menuItemId === MENU_CLIP_LINK && info.linkUrl) {
      const res = await clipUrl(serverUrl, {
        url: info.linkUrl,
        ...(parentId ? { parentId } : {}),
      });
      await flashBadge('OK', '#16a34a', `Clipped "${res.extractedTitle || res.note.title}" to Joplin Web`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Clip failed';
    await flashBadge('!', '#dc2626', `Clip failed: ${msg}`);
    if (err instanceof AuthRequiredError) {
      chrome.tabs.create({ url: serverUrl });
    }
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.type === 'CLIP_PAGE') {
    performClip({
      tabId: message.tabId,
      mode: message.mode,
      title: message.title,
      parentId: message.parentId,
      tags: message.tags,
      serverUrl: message.serverUrl,
      onProgress: (statusText) => {
        chrome.runtime.sendMessage({ type: 'CLIP_PROGRESS', text: statusText }).catch(() => {});
      },
    })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : 'Clip failed',
          code:
            err instanceof AuthRequiredError
              ? 'AUTH_REQUIRED'
              : err instanceof OriginRejectedError
                ? 'ORIGIN_REJECTED'
                : 'ERROR',
        });
      });
    return true;
  }

  return false;
});

// Exposed for automated Playwright verification if needed
globalThis.__joplinClipper = {
  performClip,
  saveSingleImage,
  clipUrl,
};
