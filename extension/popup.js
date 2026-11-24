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
  modeButtons: Array.from(document.querySelectorAll('.mode-btn')),
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

const state = {
  serverUrl: '',
  tabId: null,
  mode: 'article',
  hasSelection: false,
  notebooks: [],
  allTags: [],
  selectedTags: [],
  busy: false,
};

function showView(name) {
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

function setMode(mode) {
  state.mode = mode;
  for (const btn of el.modeButtons) {
    btn.setAttribute('aria-pressed', btn.dataset.mode === mode ? 'true' : 'false');
  }
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
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get('tabId');
  if (explicit && /^\d+$/.test(explicit)) {
    return chrome.tabs.get(Number(explicit));
  }
  const active = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active[0] && active[0].url && /^https?:\/\//i.test(active[0].url)) {
    return active[0];
  }
  const all = await chrome.tabs.query({ currentWindow: true });
  const webTabs = all
    .filter((t) => t.url && /^https?:\/\//i.test(t.url))
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return webTabs[0] || active[0] || null;
}

async function inspectTab(tab) {
  if (!tab || typeof tab.id !== 'number' || !tab.url || !/^https?:\/\//i.test(tab.url)) {
    return { title: (tab && tab.title) || '', url: (tab && tab.url) || '', hasSelection: false };
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
      return results[0].result;
    }
  } catch {
    // Fallback to tab metadata if page blocks script injection
  }
  return { title: tab.title || '', url: tab.url, hasSelection: false };
}

async function init() {
  showView('loading');
  showError('');

  const serverUrl = await getServerUrl();
  state.serverUrl = serverUrl;
  if (!serverUrl) {
    showView('setup');
    const params = new URLSearchParams(window.location.search);
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
    state.tabId = tab && typeof tab.id === 'number' ? tab.id : null;

    // Populate notebook dropdown
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

    const info = await inspectTab(tab);
    el.titleInput.value = info.title || '';
    state.hasSelection = Boolean(info.hasSelection);

    const selBtn = el.modeButtons.find((b) => b.dataset.mode === 'selection');
    if (selBtn) selBtn.disabled = !state.hasSelection;

    let initialMode = prefs.lastMode || 'article';
    if (initialMode === 'selection' && !state.hasSelection) {
      initialMode = 'article';
    }
    if (!['article', 'selection', 'fullpage', 'screenshot', 'bookmark'].includes(initialMode)) {
      initialMode = 'article';
    }
    setMode(initialMode);

    if (state.notebooks.length === 0) {
      showError('No writable notebook found. Create a non-encrypted notebook in Joplin Web first.');
      el.saveBtn.disabled = true;
    } else if (!tab || !tab.url || !/^https?:\/\//i.test(tab.url)) {
      showError('Open a normal http:// or https:// web page to clip it.');
      el.saveBtn.disabled = true;
    } else {
      el.saveBtn.disabled = false;
    }

    showView('form');
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
  if (state.busy || state.tabId === null) return;
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
    });

    if (!response || !response.ok) {
      if (response && response.code === 'AUTH_REQUIRED') {
        el.signinMessage.textContent = `Your session expired. Open ${state.serverUrl} and sign in.`;
        showView('signin');
        return;
      }
      showError((response && response.error) || 'Could not save clip to Joplin Web.');
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
    el.saveBtn.disabled = false;
    el.progressText.classList.add('hidden');
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'CLIP_PROGRESS' && typeof msg.text === 'string') {
    el.progressText.textContent = msg.text;
    el.progressText.classList.remove('hidden');
  }
});

for (const btn of el.modeButtons) {
  btn.addEventListener('click', () => {
    if (!btn.disabled) setMode(btn.dataset.mode);
  });
}

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
el.clipAgainBtn.addEventListener('click', () => {
  showError('');
  showView('form');
});

void init();
