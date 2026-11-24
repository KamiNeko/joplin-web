# Clip to Joplin Web (Chrome Extension)

A plain JavaScript Manifest V3 browser extension (no build step, no bundler) that clips rendered web pages directly into your self-hosted [Joplin Web](../README.md) instance.

- **Extension ID:** `nlplgmnmaigjhfbhkbmcpfcdnppaklco` (fixed via the public `key` in [`manifest.json`](manifest.json) so unpacked installations always get the same ID)
- **Keyboard shortcut:** `Alt+Shift+J`

## Features

- **Five clip modes:**
  - **Article:** runs Mozilla Readability on a clone of the live DOM and saves a clean Markdown note.
  - **Selection:** clips the currently selected HTML as Markdown.
  - **Full page:** strips scripts, styles, iframes, forms, and hidden elements and saves an HTML note.
  - **Screenshot:** captures the visible tab as a PNG attachment with a source link.
  - **Bookmark:** saves the page title, URL, description, and `og:image` (as an attachment).
- **Local attachments for images:** resolves relative URLs, `srcset`, `<picture>`, and lazy-loaded attributes (`data-src`, `data-original`, `data-lazy-src`), fetches images with your browser cookies (including `data:` URIs), uploads them via `POST /api/resources`, and rewrites them to `:/<resourceId>` links (up to 50 images per clip, skipping images over 10 MB or that fail to fetch).
- **Context menu:** right-click to *Clip selection to Joplin Web*, *Save image to Joplin Web*, or *Clip link to Joplin Web* (via server-side `POST /api/clip`).
- **No stored passwords or tokens:** reuses your existing Joplin Web browser session cookie (`credentials: 'include'`).

## Setup

### 1. Allow the extension on your Joplin Web server

Set `CLIPPER_EXTENSION_IDS` in your Joplin Web server environment (e.g. `.env` or `docker-compose.yml`) and restart the server:

```bash
CLIPPER_EXTENSION_IDS=nlplgmnmaigjhfbhkbmcpfcdnppaklco
```

Multiple extension IDs can be separated by commas.

### 2. Load the extension in Chrome / Chromium / Brave / Edge

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this `extension/` directory.
3. The Settings page opens automatically on first install (or click **Details → Extension options**).
4. Enter your Joplin Web URL (for example `https://notes.example.com`), click **Save**, and click **Test connection**.
5. Make sure you are signed in to Joplin Web in the same browser profile.

## Third-party code

- [`vendor/Readability.js`](vendor/Readability.js) — Mozilla Readability (`@mozilla/readability`), Apache-2.0 ([`vendor/LICENSE.md`](vendor/LICENSE.md)).
