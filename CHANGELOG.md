# Changelog

Notable changes to Joplin Web. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and releases use [semantic versioning](https://semver.org/). Each `vX.Y.Z` tag publishes `ghcr.io/kamineko/joplin-web:X.Y.Z` and a GitHub release.

## [Unreleased]

## [1.0.1] – 2026-10-18

### Fixed

- Links to a heading in another note (`:/id#heading`) open that note and scroll to the heading, also after a reload. They used to render as plain text (#93).
- Rendering notes with very large HTML no longer stalls the browser: the link and image rewrite patterns are bounded.

### Changed

- Dependencies: React 19, Tailwind CSS 4, Vite 8, Vitest 5, ESLint 10, jsdom 30, TypeScript 7 on the server. The UI looks the same.
- Building from source needs Node.js 22.12 or newer (24 recommended, see `.nvmrc`); Node 21 can no longer build the client. The Docker image already uses Node 24.

### Internal

- Client test suite extended to 150 tests (query hooks, conflict dialog, session expiry, Markdown rendering and sanitizing, connection status).

## [1.0.0] – 2026-10-18

First stable release. Joplin Web now reads **and writes** notes on your Joplin Server; the earlier `v1.0-readonly` snapshot could only read them.

### Upgrade notes

- **Host port:** set `HOST_PORT` instead of `PORT` in `.env` to change the published port in Docker Compose. The container always listens on 3001. `PORT` still works as the host port for this release cycle and will be removed later.
- **Sign in again:** sessions now live in an httpOnly cookie instead of the browser's local storage, so everyone has to sign in once after the update.
- **`CORS_ORIGIN`:** production builds no longer allow cross-origin API calls by default (previously `http://localhost:5173`). Set `CORS_ORIGIN` only if the UI is served from another origin than the API.
- **Reverse proxy:** behind a proxy, set `PUBLIC_URL` (the address you open Joplin Web at) and `TRUST_PROXY`. Writes from other origins are rejected, and an `https://` `PUBLIC_URL` turns on the `Secure` cookie flag.

### Features

- Create, edit and delete notes in a CodeMirror Markdown editor with *Edit*, *Split* and *Preview* modes, autosave and `Ctrl+S`.
- Notebooks: create, rename, move (into another notebook or to the top level) and delete.
- To-dos, clickable task-list checkboxes in the preview, and to-do toggles in the note list.
- Tags: add, remove, rename and delete.
- Images and attachments: Joplin resources are shown inline; drop, paste or attach files to upload them. Links to notes and attachments work.
- Trash: deleted notes and notebooks can be restored or deleted permanently.
- Conflict detection: if a note changed elsewhere while you edited it, you choose which version to keep.
- Search from the header field (`Ctrl+K`).
- Connection status at the bottom of the sidebar (updated, refreshing, saving, server error, offline, session expired). Its popover shows the Joplin Server host, the account, the last update and error, a *Refresh* button and the app version.
- Lists and the open note refresh when you return to the tab or come back online. A newer version of the open note loads directly if you haven't typed anything; with unsaved edits a banner lets you choose.
- No lost typing: an offline banner, automatic retries of failed saves, and a local draft of unsaved text that is offered for restore. Drafts belong to one account and server, expire after 7 days and are removed on sign-out.
- A "Session expired" prompt signs you in again and returns to the same note instead of losing unsaved text.
- *About Joplin Web* in the user menu, and `GET /api/health` with the running `version` and `commit`.
- Error states with a Retry button instead of empty lists; a "Couldn't refresh" hint when older data stays on screen.
- Accessibility: keyboard-operable sidebar, screen-reader announcements, WCAG AA contrast in light and dark mode, themed toasts.

### Security

- httpOnly `SameSite=Strict` session cookie (`Secure` `__Host-` cookie over HTTPS); the token is no longer stored in the browser or echoed by `/api/auth/check`.
- Origin check on every write as CSRF protection; requests with conflicting session cookies are rejected.
- Logout ends the session on Joplin Server and clears the server-side cache.
- Content Security Policy; remote images are blocked unless `ALLOW_REMOTE_IMAGES` is set. SVG attachments are shown safely.
- Rate limits on the API, validated item ids before any Joplin path is built, and error responses that don't leak internals. Login logs no email address.

### Data safety

- Updates start from the item's original properties and change only the edited fields; unknown properties, property order and CRLF line endings are preserved.
- Writes are refused when the account uses end-to-end encryption, and for encrypted or trashed targets.
- Permanent deletion only removes notes that are actually in the trash; restoring a notebook brings back only what was trashed with it.
- Task checkboxes toggle exactly the task you clicked; editor saves are serialized so closing the editor cannot race autosave.
- Items deleted on another device are dropped from the cache.

### Deployment

- Multi-arch images (amd64, arm64) at `ghcr.io/kamineko/joplin-web` for every release tag, with OCI labels and a GitHub release.
- One container serves the API and the web app on port 3001. Node.js 24 LTS, lockfile-exact installs, read-only app files, no npm in the runtime image, healthcheck through `node`.
- Docker Compose passes every variable from `.env` to the container (`CACHE_TTL_MS` and `AUTH_CACHE_TTL_MS` were ignored before) and reports a missing `JOPLIN_SERVER_URL` at `docker compose up`.
- `.env.example` holds production values only; use `server/.env.example` for development.
- Dependabot updates for npm, GitHub Actions and the Docker base image.

### Removed

- `timestamp` from the `GET /api/health` response.
