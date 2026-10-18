# Joplin Web

Web client for self-hosted **Joplin Server**. Target users are self-hosters who already run Joplin Server and want their notes in a browser. A React SPA talks to an Express backend, which speaks Joplin's sync protocol to Joplin Server. There is no database: the backend keeps a per-session in-memory cache.

Read [docs/architecture.md](docs/architecture.md) before touching the sync protocol, the serializer, the cache or the REST API.

## Layout

- `client/`: React 18 + Vite + TypeScript, Tailwind, shadcn/ui (`src/components/ui/` is generated), TanStack Query, CodeMirror 6. Import alias `@/` → `client/src/`. Tests sit next to the code as `*.test.ts(x)` (Vitest + Testing Library, jsdom; config in `vitest.config.ts`); `src/test/` has the `fetch` stub and `renderWithProviders`. End-to-end smoke tests live in `client/e2e/` (Playwright, `playwright.config.ts` starts the demo on :3201/:5201).
- `server/`: Express + TypeScript (ESM, `NodeNext`: relative imports need the `.js` suffix).
  - `src/services/`: `joplin-api` (HTTP client), `serializer` (Joplin text format), `note-cache` (reads), `note-writer` (writes).
  - `demo/`: in-memory **mock Joplin Server** + seed data (`demoId(key)` gives stable ids). Used by demo mode, tests and screenshots.
  - `test/`: Node test runner (`node:test` via `tsx --test`). `api.test.ts` runs the whole API against the mock.
- `docker/Dockerfile`: multi-stage build into one container serving API and static client on port 3001.
- `.github/workflows/ci.yml`: typecheck, tests, lint, build, Docker image build.

## Commands

```bash
npm --prefix server run typecheck   # tsc for src + test/demo
npm --prefix server test            # serializer + API tests against the mock (offline)
npm --prefix server run demo        # mock Joplin Server :22300 + API (PORT, default 3001)
npm --prefix server run dev         # API against JOPLIN_SERVER_URL from server/.env
npm --prefix client run lint
npm --prefix client run build       # tsc -b + vite build
npm --prefix client test            # Vitest + Testing Library (jsdom), offline
npm --prefix client run test:e2e    # Playwright smoke tests; starts the demo itself (Chrome, or E2E_EXECUTABLE_PATH)
npm --prefix client run dev         # Vite :5173, proxies /api to API_PROXY_TARGET (default :3001)
npm --prefix client run screenshots # README screenshots into docs/images (demo must run; SCREENSHOT_BASE_URL)
```

Browser preview: `.claude/launch.json` has `demo-server` (API :3101) and `demo-client` (Vite :5174, proxied to :3101). Use these so you don't clash with a user's own dev servers on :3001/:5173. Demo login: `demo@joplin-web.test` / `demo` (from `server/demo/seed.ts`).

## Rules

- **Never test against a Joplin Server with real notes, and never commit session tokens, passwords or real server URLs.** Use the mock. If a feature needs a new Joplin Server endpoint, add it to `server/demo/mock-joplin-server.ts` first.
- **Preserve Joplin data.** Updates start from the item's original property set and change only edited fields + timestamps. Never drop unknown properties. Validate ids (`^[0-9a-f]{32}$`) before building Joplin paths. Refuse writes to encrypted items.
- Every write path must keep conflict detection (`baseUpdatedTime` → 409) and update the cache (`noteCache.upsertItem` / `removeItem`).
- Serializer changes need round-trip tests in `server/test/serializer.test.ts`. New or changed endpoints need a case in `server/test/api.test.ts`.
- Client: server state goes through TanStack Query hooks in `client/src/hooks`. Mutations invalidate the affected queries. Style with Tailwind tokens from `index.css` (`bg-background`, `text-muted-foreground`, …); both themes and mobile width must work.
- Match the surrounding code: JSDoc on exported functions, comments only where intent isn't obvious.
- User-facing changes: update the README feature list if needed and refresh screenshots when the UI visibly changed. Update `docs/architecture.md` when the API, protocol usage or module responsibilities change.

## Definition of done

1. `npm --prefix server run typecheck && npm --prefix server test`
2. `npm --prefix client run lint && npm --prefix client run build && npm --prefix client test` (warnings OK, no errors)
   For changes to user flows also `npm --prefix client run test:e2e` (CI runs it).
3. UI changes: check in the browser preview against the demo, in light + dark and at phone width (~390px).
4. Docs updated as described above.

## Git

Branches `feature/<topic>` or `fix/<topic>` off `main`. Conventional commit subjects (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `ci:`). Open PRs against `main`. Commit or push only when asked.

## Agents (`.claude/agents/`)

Delegate to these when the task matches; several can run in parallel on independent parts.

| Agent | Use for |
| :--- | :--- |
| `test-engineer` | Writing/extending tests, reproducing bugs as failing tests, test infrastructure |
| `docs-writer` | README, architecture docs, screenshots, changelog-style summaries |
| `refactorer` | Behaviour-preserving cleanups, deduplication, type tightening |
| `code-reviewer` | Read-only review of a diff/branch before commit or PR |
| `joplin-protocol` | Anything touching sync format, serializer, cache, writer, mock server |
| `ui-ux` | Visual/interaction changes, accessibility, responsive layout, design consistency |
| `security-auditor` | Auth/session handling, input validation, headers, dependencies, secrets |
| `deployment` | Dockerfile, compose, CI workflows, env/config, release process |

Agents that edit code must still meet the definition of done. Agents report problems they notice outside their task instead of silently fixing them.

## Known gaps

- Client tests cover `lib/` helpers, mutation hooks, the 409 conflict dialog, session expiry, Markdown rendering, the connection status, `NoteViewer`, the pages (`LoginPage`, `NotesPage`), sidebar and notebook tree, search, the tag editor and attachment uploads; component tests stub `fetch` with `src/test/fetch-mock.ts`. The Playwright smoke tests in `client/e2e/` cover sign-in, browsing, create/edit/tag/search/trash/restore, an attachment and the phone layout against the demo. Not covered yet: the trash's notebook list (restore/purge of notebooks), the editor's Split/Preview modes and drag & drop.
- E2EE is not supported (writes are refused while it is enabled); changes made by Joplin Web are not yet verified end-to-end with desktop/mobile sync.
