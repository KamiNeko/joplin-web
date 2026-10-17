# Architecture

Joplin Server is a **sync target**: it stores raw items in Joplin's serialized text format and offers no consumer CRUD API for notes. Joplin Web puts an Express backend between the browser and Joplin Server that translates between a small JSON REST API and the sync protocol.

```mermaid
flowchart LR
    subgraph Browser
        A["React SPA<br/>Vite · Tailwind · shadcn/ui · TanStack Query"]
    end
    subgraph Container["Joplin Web container"]
        B["Express backend<br/>auth · note cache · serializer · writer"]
    end
    C["Joplin Server"]
    A -->|"JSON REST /api/*<br/>Authorization: Bearer &lt;session&gt;"| B
    B -->|"Sync protocol<br/>/api/sessions, /api/items/*<br/>X-API-AUTH: &lt;session&gt;"| C
```

In production the backend also serves the compiled client (`client/dist`) on the same port.

## Backend modules (`server/src`)

| Module | Responsibility |
| :--- | :--- |
| `services/joplin-api.ts` | HTTP client for Joplin Server; maps errors to `JoplinAuthError` / `JoplinNotFoundError` / `JoplinConnectionError`. |
| `services/serializer.ts` | `deserialize` / `serialize` Joplin's text format, `stripMarkdown` for list previews. |
| `services/note-cache.ts` | Per-session in-memory cache of all items, refreshed after `CACHE_TTL_MS`; only items whose `updated_time` changed are re-fetched. Builds the notebook tree, note lists, tag counts and search. |
| `services/note-writer.ts` | All writes: create/update/trash/restore/purge for notes, notebooks, tags, note-tag links and resources; conflict detection. |
| `middleware/auth.ts` | Accepts the session as `Authorization: Bearer`, `X-API-AUTH` or `?auth=`; validates it against Joplin Server and caches the result for `AUTH_CACHE_TTL_MS`. |
| `routes/*.ts` | Thin Express routers per resource. |

## Joplin sync protocol

### Endpoints used

| Call | Purpose |
| :--- | :--- |
| `GET /api/ping` | Health check |
| `POST /api/sessions` `{ email, password }` | Login, returns `{ id, user_id }` |
| `GET /api/items/root:/:/children?cursor=` | Paginated listing of all items (`{ items, has_more, cursor }`) |
| `GET /api/items/root:/<id>.md:/content` | Raw item text |
| `GET /api/items/root:/.resource/<id>:/content` | Attachment binary |
| `PUT /api/items/root:/<name>:/content` | Create or replace an item (multipart, field `file`) |
| `DELETE /api/items/root:/<name>:` | Delete an item |

### Item types (`type_`)

`1` Note · `2` Folder (notebook) · `4` Resource (attachment metadata) · `5` Tag · `6` Note–tag link. Other types (settings, revisions, …) are ignored. Every item is stored as `<32-hex-id>.md`; attachment binaries live at `.resource/<id>`.

### Serialized format

```text
Title line

Markdown body (notes only)…

id: b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6
parent_id: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6
created_time: 2026-10-17T16:00:00.000Z
updated_time: 2026-10-17T16:05:00.000Z
is_todo: 0
type_: 1
```

- Properties are parsed **bottom-up** until the first blank line; line 1 above it is the title, the rest (after one blank line) is the body.
- Newlines in property values are escaped as `\n`.
- Notes reference attachments as `![alt](:/<resourceId>)` and other notes as `[text](:/<noteId>)`; the client resolves these to `/api/resources/:id` and in-app links.

### Write rules

- Serialization mirrors Joplin's `BaseItem.serialize`. The title line is always written (even when empty), so a body is never read back as a title.
- Updates start from the item's **original property set** and change only the edited fields plus `updated_time` / `user_updated_time`. Unknown properties round-trip untouched.
- New items get the full default property set Joplin desktop writes (32-hex id, `markup_language: 1`, `source: joplin-web`, …).
- Ids in paths are validated against `^[0-9a-f]{32}$` before any request is made.
- Encrypted items (`encryption_applied: 1`) are rejected for writing.
- **Conflicts:** writes carry the `baseUpdatedTime` the editor started from; the writer re-reads the item and answers `409` with the current version if it changed. The UI offers *Overwrite* (`force: true`) or *Load theirs*.
- **Trash:** deleting sets `deleted_time`. Trashing a notebook also trashes its sub-notebooks and their notes; restoring a note restores its trashed parent notebooks. Permanent deletion also removes note–tag links.
- After each write the cache is updated immediately, so lists reflect the change without waiting for the TTL.

## REST API (backend → browser)

All routes except `/api/health` and `/api/auth/login` require a session.

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Health check |
| `POST` | `/api/auth/login` | `{ email, password }` → `{ sessionId, userId }` |
| `POST` | `/api/auth/logout` | Drops cached session state |
| `GET` | `/api/auth/check` | Validates the session |
| `GET` | `/api/notebooks` | Nested notebook tree with note counts |
| `POST` | `/api/notebooks/refresh` | Forces a cache re-sync |
| `POST` | `/api/notebooks` | Create notebook `{ title, parentId }` |
| `PUT` | `/api/notebooks/:id` | Rename / move notebook |
| `DELETE` | `/api/notebooks/:id` | Trash notebook; `?permanent=true` deletes a trashed one |
| `GET` | `/api/notes` | List; filters `notebook_id`, `tag_id`, `is_trash` |
| `GET` | `/api/notes/:id` | Note with body, notebook and tags |
| `POST` | `/api/notes` | Create `{ title, body, parentId, isTodo }` |
| `PUT` | `/api/notes/:id` | Update `{ title, body, parentId, todoCompleted, baseUpdatedTime, force }` |
| `DELETE` | `/api/notes/:id` | Trash; `?permanent=true` deletes |
| `POST` | `/api/notes/:id/restore` | Restore from trash |
| `POST` | `/api/notes/:id/tags` | Add tag by title `{ title }` |
| `DELETE` | `/api/notes/:id/tags/:tagId` | Remove tag from note |
| `GET` | `/api/tags` | Tags with note counts |
| `PUT` | `/api/tags/:id` | Rename tag |
| `DELETE` | `/api/tags/:id` | Delete tag and its links |
| `GET` | `/api/search?q=` | Full-text search over titles and bodies |
| `POST` | `/api/resources` | Upload attachment (raw body, `X-File-Name`, `X-File-Type`) |
| `GET` | `/api/resources/:id` | Attachment binary |
| `DELETE` | `/api/resources/:id` | Delete attachment |

## Frontend (`client/src`)

- `lib/api.ts`: fetch wrapper; stores the session in `localStorage`.
- `hooks/use-*.ts`: TanStack Query hooks; `use-mutations.ts` invalidates note/notebook/tag queries after writes.
- `pages/NotesPage.tsx`: three-pane layout (sidebar, note list, note view/editor), driven by the routes `/notes/:id`, `/notebooks/:notebookId/notes/:id`, `/trash/:id` and `?tag=`.
- `components/notes/NoteEditor.tsx`: CodeMirror editor, Edit/Split/Preview, debounced autosave, `Ctrl+S`, conflict dialog, attachment upload.
- `components/ui/`: generated shadcn/ui primitives. Avoid hand-editing them.

## Mock Joplin Server (`server/demo`)

`mock-joplin-server.ts` implements the endpoints above in memory; `seed.ts` builds sample notebooks, notes, tags and an image with stable ids (`demoId(key)`). It backs `npm run demo`, the API tests and the README screenshots. When Joplin Web starts using a new Joplin Server endpoint, add it to the mock too.
