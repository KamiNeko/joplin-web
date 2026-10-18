# Changelog

Notable changes to Joplin Web. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and releases use [semantic versioning](https://semver.org/). Each `vX.Y.Z` tag publishes `ghcr.io/kamineko/joplin-web:X.Y.Z` and a GitHub release.

## [Unreleased]

### Added

- Release workflow: `vX.Y.Z` tags publish multi-arch images (amd64, arm64) to GHCR with OCI labels, plus a GitHub release.
- Dependabot updates for npm (server, client), GitHub Actions and the Docker base image.
- `GET /api/health` reports the running `version` and `commit`. Both are set at build time (`APP_VERSION` and `GIT_SHA` build args) and are also available to the client.
- `HOST_PORT` chooses the host port in Docker Compose.

### Changed

- Node.js 24 LTS in the Docker image and CI (Node.js 20 is end-of-life). `.nvmrc` and `engines` declare the supported version (22 or newer).
- Docker Compose passes every variable from `.env` to the container. `CACHE_TTL_MS` and `AUTH_CACHE_TTL_MS` were ignored before.
- The container always listens on port 3001. Docker Compose (version 2.24 or newer) treats `.env` as optional and reports a missing `JOPLIN_SERVER_URL` at `docker compose up`.
- `.env.example` now holds production values only. For local development, copy `server/.env.example` instead.
- Without `CORS_ORIGIN`, production builds no longer allow cross-origin API calls (previously `http://localhost:5173`). Set `CORS_ORIGIN` if the UI is served from another origin.
- Smaller, stricter image: lockfile-exact installs, production dependencies from a separate stage, no `chown` layer, app files read-only for the runtime user, no npm/yarn in the runtime image, healthcheck through `node` instead of `curl`.

### Deprecated

- `PORT` as the published host port in Docker Compose. It still works for this release cycle; rename it to `HOST_PORT` in `.env`. The fallback will be removed in a later release.

### Removed

- `timestamp` from the `GET /api/health` response.
- The hard-coded "v1.0 • Synced" label in the sidebar.

### Fixed

- Failed loads of notebooks, tags, notes, search results or a note show an error with a Retry button instead of looking like empty data.
- Accessibility: notebook rows work with the keyboard, row menus are visible on touch screens, the selected item is announced, the mobile menu has a single labelled close button, and editor save problems are announced to screen readers.
- Text and buttons meet WCAG AA contrast in light and dark mode. Toasts follow the app theme instead of the OS setting.
- Note list: the filter resets when you switch notebook, tag or trash (the sort choice stays), each list has its own empty-state text, and title sorting reads A–Z/Z–A.
- On phones the editor highlights Edit when the stored layout is split, and Ctrl+K focuses the search field in the menu.
