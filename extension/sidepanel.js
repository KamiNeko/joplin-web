import {
  AuthRequiredError,
  checkAuth,
  fetchNotebooks,
  fetchTags,
  findDefaultNotebookId,
  flattenWritableNotebooks,
  getPreferences,
  getServerUrl,
} from './lib/api.js';

const views = {
  loading: document.getElementById('loading-view'),
  setup: document.getElementById('setup-view'),
  signin: document.getElementById('signin-view'),
  form: document.getElementById('form-view'),
  success: document.getElementById('success-view'),
};

const el = {
  openOptionsBtn: document.getElementById('open-options-btn'),
  setupOptionsBtn: document.getElementById('setup-options-btn'),
  signinBtn: document.getElementById('signin-btn'),
  retryBtn: document.getElementById('retry-btn'),
  signinMessage: document.getElementById('signin-message'),
  errorBanner: document.getElementById('error-banner'),
  pageNotice: document.getElementById('page-notice'),
  pageMeta: document.getElementById('page-meta'),
  pageHost: document.getElementById('page-host'),
  modeButtons: Array.from(document.querySelectorAll('.mode-btn')),
  selectionSummary: document.getElementById('selection-summary'),
  summaryText: document.getElementById('summary-text'),
  summaryHint: document.getElementById('summary-hint'),
  resetOverlayBtn: document.getElementById('reset-overlay-btn'),
  titleInput: document.getElementById('clip-title'),
  notebookSelect: document.getElementById('clip-notebook'),
  tagsWrap: document.getElementById('tags-wrap'),
  tagInput: document.getElementById('clip-tag-input'),
  tagSuggestions: document.getElementById('tag-suggestions'),
  saveBtn: document.getElementById('save-btn'),
  progressText: document.getElementById('progress-text'),
  successMessage: document.getElementById('success-message'),
  skippedBanner: document.getElementById('skipped-banner'),
  openNoteLink: document.getElementById('open-note-link'),
  clipAgainBtn: document.getElementById('clip-again-btn'),
};

const numFmt = new Intl.NumberFormat();

const params = new URLSearchParams(window.location.search);
const pinnedTabId = (() => {
  const explicit = params.get('tabId');
  return explicit && /^\d+$/.test(explicit) ? Number(explicit) : null;
})();

const state = {
  serverUrl: '',
  ready: false,
  currentView: 'loading',
  windowId: null,
  tabId: null,
  tabUrl: '',
  canInject: false,
  isHttpUrl: false,
  mode: 'article',
  preferredMode: 'article',
  hasSelection: false,
  notebooks: [],
  allTags: [],
  selectedTags: [],
  busy: false,
  loadSeq: 0,
};

// Keep a long-lived port open to the service worker so closing the side panel always removes the overlay.
let panelPort = null;
function ensurePanelPort() {
  if (panelPort) return panelPort;
  try {
    panelPort = chrome.runtime.connect({ name: 'joplin-clipper-panel' });
    panelPort.onDisconnect.addListener(() => {
      panelPort = null;
    });
  } catch {
    panelPort = null;
  }
  return panelPort;
}

function bindPortToTab(tabId) {
  const port = ensurePanelPort();
  if (!port) return;
  try {
    port.postMessage({ type: 'PANEL_BIND_TAB', tabId: typeof tabId === 'number' ? tabId : null });
  } catch {
    // ignore disconnected port
  }
}

function showView(name) {
  state.currentView = name;
  for (const [key, node] of Object.entries(views)) {
    node.classList.toggle('hidden', key !== name);
  }
}

function showError(message) {
  if (!message) {
    el.errorBanner.textContent = '';
    el.errorBanner.classList.add('hidden');
    return;
  }
  el.errorBanner.textContent = message;
  el.errorBanner.classList.remove('hidden');
}

function showPageNotice(message) {
  if (!message) {
    el.pageNotice.textContent = '';
    el.pageNotice.classList.add('hidden');
    return;
  }
  el.pageNotice.textContent = message;
  el.pageNotice.classList.remove('hidden');
}

function renderSummary(overlayState) {
  if (!overlayState || !state.canInject) {
    el.selectionSummary.classList.add('hidden');
    return;
  }

  if (overlayState.mode === 'article') {
    const words = Number(overlayState.words || 0);
    const images = Number(overlayState.images || 0);
    const wordLabel = words === 1 ? 'word' : 'words';
    const imgLabel = images === 1 ? 'image' : 'images';
    const prefix = overlayState.adjusted ? 'Selected: ' : '';
    el.summaryText.textContent = `${prefix}~${numFmt.format(words)} ${wordLabel} · ${numFmt.format(images)} ${imgLabel}`;
    el.summaryHint.textContent = 'Drag handles, click page, +/−, Esc reset, Enter save';
    el.resetOverlayBtn.classList.toggle('hidden', !overlayState.adjusted);
    el.selectionSummary.classList.remove('hidden');
    return;
  }

  if (overlayState.mode === 'screenshot' && overlayState.cropRect) {
    const { width, height } = overlayState.cropRect;
    const areaLabel = overlayState.adjusted ? 'Custom area' : 'Full visible area';
    el.summaryText.textContent = `${numFmt.format(width)} × ${numFmt.format(height)} px · ${areaLabel}`;
    el.summaryHint.textContent = 'Drag handles or page to crop · Esc reset · Enter save';
    el.resetOverlayBtn.classList.toggle('hidden', !overlayState.adjusted);
    el.selectionSummary.classList.remove('hidden');
    return;
  }

  if (overlayState.mode === 'selection') {
    const words = Number(overlayState.words || 0);
    const images = Number(overlayState.images || 0);
    const wordLabel = words === 1 ? 'word' : 'words';
    const imgLabel = images === 1 ? 'image' : 'images';
    el.summaryText.textContent = `~${numFmt.format(words)} ${wordLabel} · ${numFmt.format(images)} ${imgLabel}`;
    el.summaryHint.textContent = 'Highlighting your current text selection on the page';
    el.resetOverlayBtn.classList.add('hidden');
    el.selectionSummary.classList.remove('hidden');
    return;
  }

  el.selectionSummary.classList.add('hidden');
}

function setModeUi(mode) {
  state.mode = mode;
  for (const btn of el.modeButtons) {
    btn.setAttribute('aria-pressed', btn.dataset.mode === mode ? 'true' : 'false');
  }
}

async function syncOverlayForMode(mode) {
  if (state.tabId === null || !state.canInject) {
    renderSummary(null);
    return;
  }
  const tabId = state.tabId;
  const seq = state.loadSeq;
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'OVERLAY_ACTIVATE',
      tabId,
      mode,
    });
    if (seq !== state.loadSeq || tabId !== state.tabId || state.mode !== mode) return;
    if (response && response.ok) {
      renderSummary(response.state || null);
    } else {
      renderSummary(null);
    }
  } catch {
    renderSummary(null);
  }
}

async function setMode(mode, { persistPreferred = true } = {}) {
  setModeUi(mode);
  if (persistPreferred) {
    state.preferredMode = mode;
  }
  await syncOverlayForMode(mode);
}

function renderTagChips() {
  for (const chip of Array.from(el.tagsWrap.querySelectorAll('.tag-chip'))) {
    chip.remove();
  }
  for (const tag of state.selectedTags) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.textContent = tag;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.setAttribute('aria-label', `Remove tag ${tag}`);
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      state.selectedTags = state.selectedTags.filter((t) => t !== tag);
      renderTagChips();
    });
    chip.appendChild(removeBtn);
    el.tagsWrap.insertBefore(chip, el.tagInput);
  }
}

function addTag(raw) {
  const parts = String(raw || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  for (const part of parts) {
    if (state.selectedTags.length >= 10) break;
    if (!state.selectedTags.some((existing) => existing.toLowerCase() === part.toLowerCase())) {
      state.selectedTags.push(part);
    }
  }
  renderTagChips();
  renderTagSuggestions('');
}

function renderTagSuggestions(query) {
  const q = query.trim().toLowerCase();
  if (!q) {
    el.tagSuggestions.innerHTML = '';
    el.tagSuggestions.classList.add('hidden');
    return;
  }
  const matches = state.allTags
    .filter(
      (t) =>
        t.toLowerCase().includes(q) &&
        !state.selectedTags.some((sel) => sel.toLowerCase() === t.toLowerCase())
    )
    .slice(0, 8);
  if (matches.length === 0) {
    el.tagSuggestions.innerHTML = '';
    el.tagSuggestions.classList.add('hidden');
    return;
  }
  el.tagSuggestions.innerHTML = '';
  for (const tag of matches) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = tag;
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      addTag(tag);
      el.tagInput.value = '';
      el.tagInput.focus();
    });
    li.appendChild(btn);
    el.tagSuggestions.appendChild(li);
  }
  el.tagSuggestions.classList.remove('hidden');
}

async function resolveTargetTab() {
  if (pinnedTabId !== null) {
    try {
      return await chrome.tabs.get(pinnedTabId);
    } catch {
      return null;
    }
  }
  const active = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active[0]) {
    state.windowId = active[0].windowId;
    return active[0];
  }
  const lastFocused = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (lastFocused[0]) {
    state.windowId = lastFocused[0].windowId;
    return lastFocused[0];
  }
  return null;
}

function isScriptBlockedUrl(url) {
  if (!url) return true;
  if (!/^https?:\/\//i.test(url)) return true;
  try {
    const u = new URL(url);
    if (
      u.hostname === 'chromewebstore.google.com' ||
      (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore'))
    ) {
      return true;
    }
  } catch {
    return true;
  }
  return false;
}

async function inspectTab(tab) {
  const url = (tab && tab.url) || '';
  const isHttpUrl = /^https?:\/\//i.test(url);
  if (!tab || typeof tab.id !== 'number' || !isHttpUrl || isScriptBlockedUrl(url)) {
    return {
      title: (tab && tab.title) || '',
      url,
      hasSelection: false,
      canInject: false,
      isPdf: /\.pdf(?:$|[?#])/i.test(url),
      isHttpUrl,
    };
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['capture.js'],
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => globalThis.__joplinClipperInspect(),
    });
    if (results && results[0] && results[0].result) {
      const info = results[0].result;
      return {
        ...info,
        canInject: !info.isPdf,
        isHttpUrl: true,
      };
    }
  } catch {
    // Injection blocked (Chrome Web Store, PDF viewer, internal pages, etc.)
  }
  return {
    title: tab.title || '',
    url,
    hasSelection: false,
    canInject: false,
    isPdf: /\.pdf(?:$|[?#])/i.test(url),
    isHttpUrl,
  };
}

function updatePageMeta(url) {
  if (!url) {
    el.pageMeta.classList.add('hidden');
    el.pageHost.textContent = '';
    return;
  }
  try {
    const parsed = new URL(url);
    const label = parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
      : url;
    el.pageHost.textContent = label;
    el.pageHost.title = url;
    el.pageMeta.classList.remove('hidden');
  } catch {
    el.pageHost.textContent = url;
    el.pageMeta.classList.remove('hidden');
  }
}

async function loadTabContext(tab, { activateOverlay = true } = {}) {
  const seq = ++state.loadSeq;
  const previousTabId = state.tabId;
  const nextTabId = tab && typeof tab.id === 'number' ? tab.id : null;

  state.tabId = nextTabId;
  state.tabUrl = (tab && tab.url) || '';
  if (tab && typeof tab.windowId === 'number') {
    state.windowId = tab.windowId;
  }

  bindPortToTab(nextTabId);

  if (previousTabId !== null && previousTabId !== nextTabId) {
    chrome.runtime.sendMessage({ type: 'OVERLAY_DESTROY', tabId: previousTabId }).catch(() => {});
  }

  showError('');
  showPageNotice('');
  updatePageMeta(state.tabUrl);

  const info = await inspectTab(tab);
  if (seq !== state.loadSeq) return;

  state.canInject = Boolean(info.canInject);
  state.isHttpUrl = Boolean(info.isHttpUrl);
  state.hasSelection = Boolean(info.hasSelection);

  el.titleInput.value = info.title || '';

  const hasNotebooks = state.notebooks.length > 0;
  if (!hasNotebooks) {
    showError('No writable notebook found. Create a non-encrypted notebook in Joplin Web first.');
  }

  if (!state.canInject) {
    renderSummary(null);
    for (const btn of el.modeButtons) {
      const m = btn.dataset.mode;
      btn.disabled = !(state.isHttpUrl && m === 'bookmark');
    }
    if (state.isHttpUrl) {
      const reason = info.isPdf
        ? 'PDF pages cannot be inspected by the clipper overlay.'
        : 'This page restricts browser extensions (such as the Chrome Web Store or PDF viewer).';
      showPageNotice(`${reason} You can still save it as a Bookmark.`);
      setModeUi('bookmark');
      el.saveBtn.disabled = !hasNotebooks;
    } else {
      showPageNotice('This page cannot be clipped. Open a standard http:// or https:// web page.');
      setModeUi('article');
      el.saveBtn.disabled = true;
    }
    return;
  }

  for (const btn of el.modeButtons) {
    const m = btn.dataset.mode;
    btn.disabled = m === 'selection' ? !state.hasSelection : false;
  }

  let initialMode = state.preferredMode || 'article';
  if (initialMode === 'selection' && !state.hasSelection) {
    initialMode = 'article';
  }
  if (!['article', 'selection', 'fullpage', 'screenshot', 'bookmark'].includes(initialMode)) {
    initialMode = 'article';
  }

  setModeUi(initialMode);
  el.saveBtn.disabled = !hasNotebooks;

  if (activateOverlay) {
    await syncOverlayForMode(initialMode);
  }
}

async function init() {
  showView('loading');
  showError('');
  ensurePanelPort();

  const serverUrl = await getServerUrl();
  state.serverUrl = serverUrl;
  if (!serverUrl) {
    showView('setup');
    if (!params.has('noAutoOpen')) {
      chrome.runtime.openOptionsPage();
    }
    return;
  }

  try {
    await checkAuth(serverUrl);
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      el.signinMessage.textContent = `Not signed in: open ${serverUrl} and sign in, then click Retry.`;
      showView('signin');
      return;
    }
    showView('form');
    showError(err instanceof Error ? err.message : 'Could not connect to Joplin Web');
    return;
  }

  try {
    const [notebooksTree, tagsList, prefs, tab] = await Promise.all([
      fetchNotebooks(serverUrl),
      fetchTags(serverUrl).catch(() => []),
      getPreferences(),
      resolveTargetTab(),
    ]);

    state.notebooks = flattenWritableNotebooks(notebooksTree);
    state.allTags = Array.isArray(tagsList)
      ? tagsList.filter((t) => t && !t.encrypted && typeof t.title === 'string').map((t) => t.title)
      : [];
    state.preferredMode = prefs.lastMode || 'article';
    state.ready = true;

    el.notebookSelect.innerHTML = '';
    for (const nb of state.notebooks) {
      const opt = document.createElement('option');
      opt.value = nb.id;
      opt.textContent = `${'— '.repeat(nb.depth)}${nb.title}`;
      el.notebookSelect.appendChild(opt);
    }
    const defaultNb = findDefaultNotebookId(state.notebooks, prefs.lastNotebookId);
    if (defaultNb) {
      el.notebookSelect.value = defaultNb;
    }

    showView('form');
    await loadTabContext(tab, { activateOverlay: true });
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      el.signinMessage.textContent = `Not signed in: open ${serverUrl} and sign in, then click Retry.`;
      showView('signin');
      return;
    }
    showView('form');
    showError(err instanceof Error ? err.message : 'Failed to load notebooks from Joplin Web.');
  }
}

async function handleSave() {
  if (state.busy || state.tabId === null || el.saveBtn.disabled) return;
  if (el.tagInput.value.trim()) {
    addTag(el.tagInput.value);
    el.tagInput.value = '';
  }

  state.busy = true;
  showError('');
  el.saveBtn.disabled = true;
  el.progressText.textContent = 'Starting clip…';
  el.progressText.classList.remove('hidden');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'CLIP_PAGE',
      tabId: state.tabId,
      mode: state.mode,
      title: el.titleInput.value.trim(),
      parentId: el.notebookSelect.value,
      tags: state.selectedTags,
      serverUrl: state.serverUrl,
      useOverlaySelection: true,
    });

    if (!response || !response.ok) {
      if (response && response.code === 'AUTH_REQUIRED') {
        el.signinMessage.textContent = `Your session expired. Open ${state.serverUrl} and sign in.`;
        showView('signin');
        return;
      }
      showError((response && response.error) || 'Could not save clip to Joplin Web.');
      // Re-activate overlay if screenshot hid it and save failed
      if (state.mode === 'screenshot' && state.canInject) {
        await syncOverlayForMode(state.mode);
      }
      return;
    }

    const { note, skippedImages } = response.result;
    const nb = state.notebooks.find((n) => n.id === (note.parentId || el.notebookSelect.value));
    const nbName = nb ? nb.title : 'Joplin Web';
    el.successMessage.textContent = `Saved "${note.title}" to ${nbName}`;

    if (skippedImages > 0) {
      el.skippedBanner.textContent = `${skippedImages} image${skippedImages === 1 ? '' : 's'} skipped (failed to download or exceeded 10 MB / 50-image limit).`;
      el.skippedBanner.classList.remove('hidden');
    } else {
      el.skippedBanner.classList.add('hidden');
    }

    el.openNoteLink.href = `${state.serverUrl}/notes/${note.id}`;
    showView('success');
  } catch (err) {
    showError(err instanceof Error ? err.message : 'Unexpected error while clipping.');
  } finally {
    state.busy = false;
    el.saveBtn.disabled = state.notebooks.length === 0 || (!state.canInject && !state.isHttpUrl);
    el.progressText.classList.add('hidden');
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'CLIP_PROGRESS' && typeof msg.text === 'string') {
    el.progressText.textContent = msg.text;
    el.progressText.classList.remove('hidden');
    return;
  }

  const msgTabId = sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : msg.tabId;
  if (msgTabId !== state.tabId) return;

  if (msg.type === 'OVERLAY_STATE' && msg.state) {
    if (msg.state.mode === 'selection') {
      state.hasSelection = Boolean(msg.state.hasSelection);
      const selBtn = el.modeButtons.find((b) => b.dataset.mode === 'selection');
      if (selBtn) selBtn.disabled = !state.hasSelection;
    }
    if (msg.state.mode === state.mode) {
      renderSummary(msg.state);
    }
  } else if (msg.type === 'OVERLAY_SAVE') {
    if (state.currentView === 'form' && !state.busy) {
      void handleSave();
    }
  }
});

// Follow active tab switches when not pinned by ?tabId=
if (pinnedTabId === null) {
  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    if (!state.ready || state.busy) return;
    if (state.windowId !== null && activeInfo.windowId !== state.windowId) return;
    try {
      const tab = await chrome.tabs.get(activeInfo.tabId);
      if (state.currentView === 'success') {
        showView('form');
      }
      if (state.currentView === 'form') {
        await loadTabContext(tab, { activateOverlay: true });
      }
    } catch {
      // tab may have closed
    }
  });
}

// Refresh when the tracked tab navigates or finishes reloading
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!state.ready || state.busy || tabId !== state.tabId) return;
  const navigated =
    changeInfo.status === 'complete' ||
    (typeof changeInfo.url === 'string' && changeInfo.url !== state.tabUrl);
  if (!navigated) return;
  if (state.currentView === 'success') {
    showView('form');
  }
  if (state.currentView === 'form') {
    await loadTabContext(tab, { activateOverlay: true });
  }
});

for (const btn of el.modeButtons) {
  btn.addEventListener('click', () => {
    if (!btn.disabled) {
      void setMode(btn.dataset.mode);
    }
  });
}

el.resetOverlayBtn.addEventListener('click', async () => {
  if (state.tabId === null || !state.canInject) return;
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'OVERLAY_RESET',
      tabId: state.tabId,
    });
    if (res && res.ok && res.state) {
      renderSummary(res.state);
    }
  } catch {
    // ignore
  }
});

el.tagInput.addEventListener('input', () => {
  if (el.tagInput.value.includes(',')) {
    addTag(el.tagInput.value);
    el.tagInput.value = '';
    return;
  }
  renderTagSuggestions(el.tagInput.value);
});

el.tagInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (el.tagInput.value.trim()) {
      addTag(el.tagInput.value);
      el.tagInput.value = '';
    }
  } else if (e.key === 'Backspace' && !el.tagInput.value && state.selectedTags.length > 0) {
    state.selectedTags.pop();
    renderTagChips();
  }
});

el.tagInput.addEventListener('blur', () => {
  setTimeout(() => el.tagSuggestions.classList.add('hidden'), 120);
});

el.openOptionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
el.setupOptionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
el.signinBtn.addEventListener('click', () => {
  if (state.serverUrl) chrome.tabs.create({ url: state.serverUrl });
});
el.retryBtn.addEventListener('click', () => void init());
el.saveBtn.addEventListener('click', () => void handleSave());
el.clipAgainBtn.addEventListener('click', async () => {
  showError('');
  showView('form');
  const tab = await resolveTargetTab();
  await loadTabContext(tab, { activateOverlay: true });
});

window.addEventListener('pagehide', () => {
  if (state.tabId !== null) {
    chrome.runtime.sendMessage({ type: 'OVERLAY_DESTROY', tabId: state.tabId }).catch(() => {});
  }
});

void init();
