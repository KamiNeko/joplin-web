import { getServerUrl, normalizeServerUrl, setServerUrl, testConnection } from './lib/api.js';

const form = document.getElementById('options-form');
const serverInput = document.getElementById('server-url');
const testBtn = document.getElementById('test-btn');
const statusBanner = document.getElementById('status-banner');
const envSnippet = document.getElementById('env-snippet');
const copyEnvBtn = document.getElementById('copy-env-btn');

const extensionId = chrome.runtime.id;
const envText = `CLIPPER_EXTENSION_IDS=${extensionId}`;
envSnippet.textContent = envText;

function setStatus(kind, message, linkUrl = '') {
  statusBanner.className = 'banner';
  if (kind === 'ok') statusBanner.classList.add('banner-success');
  else if (kind === 'warn') statusBanner.classList.add('banner-warn');
  else statusBanner.classList.add('banner-error');

  statusBanner.textContent = '';
  if (linkUrl) {
    const idx = message.indexOf(linkUrl);
    if (idx !== -1) {
      statusBanner.appendChild(document.createTextNode(message.slice(0, idx)));
      const a = document.createElement('a');
      a.href = linkUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = linkUrl;
      statusBanner.appendChild(a);
      statusBanner.appendChild(document.createTextNode(message.slice(idx + linkUrl.length)));
      return;
    }
  }
  statusBanner.textContent = message;
}

async function loadInitial() {
  const existing = await getServerUrl();
  if (existing) {
    serverInput.value = existing;
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const saved = await setServerUrl(serverInput.value);
    serverInput.value = saved;
    setStatus('ok', `Saved server URL: ${saved}`);
  } catch (err) {
    setStatus('error', err instanceof Error ? err.message : 'Invalid URL');
  }
});

testBtn.addEventListener('click', async () => {
  let url;
  try {
    url = normalizeServerUrl(serverInput.value);
    if (!url) throw new Error('Enter your Joplin Web server URL first.');
    await setServerUrl(url);
    serverInput.value = url;
  } catch (err) {
    setStatus('error', err instanceof Error ? err.message : 'Invalid URL');
    return;
  }

  testBtn.disabled = true;
  setStatus('warn', 'Testing connection…');
  try {
    const result = await testConnection(url);
    if (result.status === 'ok') {
      setStatus('ok', result.message);
    } else if (result.status === 'unauthenticated') {
      setStatus('warn', result.message, url);
    } else {
      setStatus('error', result.message);
    }
  } finally {
    testBtn.disabled = false;
  }
});

copyEnvBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(envText);
    copyEnvBtn.textContent = 'Copied';
    setTimeout(() => {
      copyEnvBtn.textContent = 'Copy';
    }, 1500);
  } catch {
    copyEnvBtn.textContent = 'Failed';
  }
});

void loadInitial();
