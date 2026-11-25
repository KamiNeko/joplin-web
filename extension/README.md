# Clip to Joplin Web (Chrome Extension)

A plain JavaScript Manifest V3 browser extension (no build step, no bundler) that clips rendered web pages directly into your self-hosted [Joplin Web](../README.md) instance from a persistent Chrome **Side Panel** with an Evernote-style interactive selection overlay.

- **Extension ID:** `nlplgmnmaigjhfbhkbmcpfcdnppaklco` (fixed via the public `key` in [`manifest.json`](manifest.json) so unpacked installations always get the same ID)
- **Keyboard shortcut:** `Alt+Shift+J` (opens the side panel)

## Features

- **Persistent Side Panel:** stays open while you inspect and adjust the clip region on the page, automatically follows the active tab and page navigations, and supports both light and dark themes.
- **Interactive in-page overlay (shadow DOM, strict-CSP compatible):**
  - **Article:** detects the main article via Mozilla Readability mapped back to the live DOM, dimming the rest of the page and framing the selected area:
    - **Drag handles** on all four edges and corners to include more or exclude less; on release the box snaps to whole block-level elements (≥ 60% inside, top-most, in document order) and auto-scrolls when dragging past the viewport edge.
    - **`+` / `−` buttons** (or **`↑` / `↓`** keys) to expand to the parent element or shrink to the largest child.
    - **Click to pick:** hover to outline any block element and click to select just that element (page clicks are captured so links don't navigate; scrolling still works).
    - **`Esc`** resets to the detected article; **`Enter`** saves the clip.
    - **Live summary** in the side panel shows estimated word and image counts as you adjust the box.
    - Unadjusted clips keep Readability's clean Markdown output; adjusted clips save the exact highlighted elements (cleaned of scripts, styles, hidden elements, forms, buttons, and iframes) as Markdown.
  - **Selection:** highlights your current text selection on the page and saves it as Markdown.
  - **Full page:** strips scripts, styles, iframes, forms, and hidden elements and saves an HTML note.
  - **Screenshot:** overlays a resizable crop rectangle (defaulting to the full visible viewport), hides the overlay before capture, crops to your chosen area (DPR-aware), and attaches the PNG with a source link.
  - **Bookmark:** saves the page title, URL, description, and `og:image` (as an attachment). Still available on restricted HTTP(S) pages (such as the Chrome Web Store or PDF viewer) where content scripts cannot run.
- **Local attachments for images:** resolves relative URLs, `srcset`, `<picture>`, and lazy-loaded attributes (`data-src`, `data-original`, `data-lazy-src`), fetches images with your browser cookies (including `data:` URIs), uploads them via `POST /api/resources`, and rewrites them to `:/<resourceId>` links (up to 50 images per clip, skipping images over 10 MB or that fail to fetch).
- **Context menu:** right-click to *Clip selection to Joplin Web*, *Save image to Joplin Web*, or *Clip link to Joplin Web* (via server-side `POST /api/clip`).
- **Clean teardown:** closing the side panel, switching tabs, or saving automatically removes the overlay and leaves the page untouched.
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
6. Click the **Clip to Joplin Web** toolbar icon (or press `Alt+Shift+J`) to open the side panel.

## Third-party code

- [`vendor/Readability.js`](vendor/Readability.js) — Mozilla Readability (`@mozilla/readability`), Apache-2.0 ([`vendor/LICENSE.md`](vendor/LICENSE.md)).
