import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RecentReadEntry, SavedSearch, UserPreferences } from '../types/index.js';
import { assertValidId, WriteValidationError } from './note-writer.js';

const OWNER_KEY_RE = /^[A-Za-z0-9_-]+$/;
const ID_RE = /^[0-9a-f]{32}$/;

export const MAX_FAVORITE_NOTES = 200;
export const MAX_FAVORITE_NOTEBOOKS = 100;
export const MAX_SAVED_SEARCHES = 100;
export const MAX_RECENT_READS = 100;
export const MAX_SCRATCHPAD_CHARS = 100_000;

function emptyPreferences(): UserPreferences {
  return {
    version: 1,
    favoriteNoteIds: [],
    favoriteNotebookIds: [],
    savedSearches: [],
    recentReads: [],
    scratchpad: '',
  };
}

function sanitizePreferences(raw: unknown): UserPreferences {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyPreferences();
  const obj = raw as Record<string, unknown>;
  const favoriteNoteIds = Array.isArray(obj.favoriteNoteIds)
    ? Array.from(new Set(obj.favoriteNoteIds.filter((id): id is string => typeof id === 'string' && ID_RE.test(id)))).slice(
        0,
        MAX_FAVORITE_NOTES
      )
    : [];
  const favoriteNotebookIds = Array.isArray(obj.favoriteNotebookIds)
    ? Array.from(
        new Set(obj.favoriteNotebookIds.filter((id): id is string => typeof id === 'string' && ID_RE.test(id)))
      ).slice(0, MAX_FAVORITE_NOTEBOOKS)
    : [];
  const savedSearches: SavedSearch[] = [];
  if (Array.isArray(obj.savedSearches)) {
    const seenIds = new Set<string>();
    for (const item of obj.savedSearches) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      if (
        typeof rec.id === 'string' &&
        rec.id &&
        !seenIds.has(rec.id) &&
        typeof rec.name === 'string' &&
        rec.name.trim() &&
        typeof rec.query === 'string' &&
        rec.query.trim()
      ) {
        seenIds.add(rec.id);
        savedSearches.push({
          id: rec.id,
          name: rec.name.trim().slice(0, 80),
          query: rec.query.trim().slice(0, 500),
          createdAt: typeof rec.createdAt === 'number' && Number.isFinite(rec.createdAt) ? rec.createdAt : Date.now(),
        });
        if (savedSearches.length >= MAX_SAVED_SEARCHES) break;
      }
    }
  }
  const recentReads: RecentReadEntry[] = [];
  if (Array.isArray(obj.recentReads)) {
    const seenNotes = new Set<string>();
    for (const entry of obj.recentReads) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      if (
        typeof rec.noteId === 'string' &&
        ID_RE.test(rec.noteId) &&
        !seenNotes.has(rec.noteId) &&
        typeof rec.readAt === 'number' &&
        Number.isFinite(rec.readAt)
      ) {
        seenNotes.add(rec.noteId);
        recentReads.push({ noteId: rec.noteId, readAt: rec.readAt });
        if (recentReads.length >= MAX_RECENT_READS) break;
      }
    }
  }
  const scratchpad =
    typeof obj.scratchpad === 'string' ? obj.scratchpad.slice(0, MAX_SCRATCHPAD_CHARS) : '';

  return {
    version: 1,
    favoriteNoteIds,
    favoriteNotebookIds,
    savedSearches,
    recentReads,
    scratchpad,
  };
}

/**
 * Per-owner workspace preferences stored in `<CACHE_DIR>/prefs/<ownerKey>.json` (or memory when
 * CACHE_DIR is null). Serializes mutations per owner with atomic temp-file writes.
 */
export class PreferencesStore {
  private readonly prefsDir: string | null;
  private readonly cache = new Map<string, UserPreferences>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(cacheDir: string | null = null) {
    this.prefsDir = cacheDir ? join(cacheDir, 'prefs') : null;
  }

  private assertOwnerKey(ownerKey: string): string {
    if (!OWNER_KEY_RE.test(ownerKey)) {
      throw new WriteValidationError('Invalid owner key', 400);
    }
    return ownerKey;
  }

  private filePath(ownerKey: string): string | null {
    return this.prefsDir ? join(this.prefsDir, `${this.assertOwnerKey(ownerKey)}.json`) : null;
  }

  private load(ownerKey: string): UserPreferences {
    this.assertOwnerKey(ownerKey);
    const cached = this.cache.get(ownerKey);
    if (cached) return cached;

    const file = this.filePath(ownerKey);
    let prefs = emptyPreferences();
    if (file) {
      try {
        prefs = sanitizePreferences(JSON.parse(readFileSync(file, 'utf8')));
      } catch {
        // Missing or unreadable file starts clean
      }
    }
    this.cache.set(ownerKey, prefs);
    return prefs;
  }

  private save(ownerKey: string, prefs: UserPreferences): void {
    this.cache.set(ownerKey, prefs);
    const file = this.filePath(ownerKey);
    if (!file || !this.prefsDir) return;
    mkdirSync(this.prefsDir, { recursive: true, mode: 0o700 });
    writeFileSync(`${file}.tmp`, JSON.stringify(prefs), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  private withOwnerLock<T>(ownerKey: string, fn: () => T | Promise<T>): Promise<T> {
    this.assertOwnerKey(ownerKey);
    const prev = this.locks.get(ownerKey) ?? Promise.resolve();
    const run = prev.then(
      () => fn(),
      () => fn()
    );
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.locks.set(ownerKey, tail);
    void tail.finally(() => {
      if (this.locks.get(ownerKey) === tail) this.locks.delete(ownerKey);
    });
    return run;
  }

  public get(ownerKey: string): UserPreferences {
    const prefs = this.load(ownerKey);
    return {
      version: 1,
      favoriteNoteIds: [...prefs.favoriteNoteIds],
      favoriteNotebookIds: [...prefs.favoriteNotebookIds],
      savedSearches: prefs.savedSearches.map((s) => ({ ...s })),
      recentReads: prefs.recentReads.map((r) => ({ ...r })),
      scratchpad: prefs.scratchpad,
    };
  }

  public addFavoriteNote(ownerKey: string, noteId: string): Promise<UserPreferences> {
    const id = assertValidId(noteId, 'note id');
    return this.withOwnerLock(ownerKey, () => {
      const prefs = this.load(ownerKey);
      if (!prefs.favoriteNoteIds.includes(id)) {
        if (prefs.favoriteNoteIds.length >= MAX_FAVORITE_NOTES) {
          throw new WriteValidationError(`Maximum ${MAX_FAVORITE_NOTES} favorite notes allowed`, 400);
        }
        prefs.favoriteNoteIds = [...prefs.favoriteNoteIds, id];
        this.save(ownerKey, prefs);
      }
      return this.get(ownerKey);
    });
  }

  public removeFavoriteNote(ownerKey: string, noteId: string): Promise<UserPreferences> {
    const id = assertValidId(noteId, 'note id');
    return this.withOwnerLock(ownerKey, () => {
      const prefs = this.load(ownerKey);
      const next = prefs.favoriteNoteIds.filter((x) => x !== id);
      if (next.length !== prefs.favoriteNoteIds.length) {
        prefs.favoriteNoteIds = next;
        this.save(ownerKey, prefs);
      }
      return this.get(ownerKey);
    });
  }

  public addFavoriteNotebook(ownerKey: string, notebookId: string): Promise<UserPreferences> {
    const id = assertValidId(notebookId, 'notebook id');
    return this.withOwnerLock(ownerKey, () => {
      const prefs = this.load(ownerKey);
      if (!prefs.favoriteNotebookIds.includes(id)) {
        if (prefs.favoriteNotebookIds.length >= MAX_FAVORITE_NOTEBOOKS) {
          throw new WriteValidationError(`Maximum ${MAX_FAVORITE_NOTEBOOKS} favorite notebooks allowed`, 400);
        }
        prefs.favoriteNotebookIds = [...prefs.favoriteNotebookIds, id];
        this.save(ownerKey, prefs);
      }
      return this.get(ownerKey);
    });
  }

  public removeFavoriteNotebook(ownerKey: string, notebookId: string): Promise<UserPreferences> {
    const id = assertValidId(notebookId, 'notebook id');
    return this.withOwnerLock(ownerKey, () => {
      const prefs = this.load(ownerKey);
      const next = prefs.favoriteNotebookIds.filter((x) => x !== id);
      if (next.length !== prefs.favoriteNotebookIds.length) {
        prefs.favoriteNotebookIds = next;
        this.save(ownerKey, prefs);
      }
      return this.get(ownerKey);
    });
  }

  public addSavedSearch(ownerKey: string, name: string, query: string): Promise<SavedSearch> {
    const cleanName = typeof name === 'string' ? name.trim().slice(0, 80) : '';
    const cleanQuery = typeof query === 'string' ? query.trim().slice(0, 500) : '';
    if (!cleanName) throw new WriteValidationError('Saved search name is required', 400);
    if (!cleanQuery) throw new WriteValidationError('Saved search query is required', 400);

    return this.withOwnerLock(ownerKey, () => {
      const prefs = this.load(ownerKey);
      if (prefs.savedSearches.length >= MAX_SAVED_SEARCHES) {
        throw new WriteValidationError(`Maximum ${MAX_SAVED_SEARCHES} saved searches allowed`, 400);
      }
      const saved: SavedSearch = {
        id: randomUUID().replace(/-/g, ''),
        name: cleanName,
        query: cleanQuery,
        createdAt: Date.now(),
      };
      prefs.savedSearches = [...prefs.savedSearches, saved];
      this.save(ownerKey, prefs);
      return { ...saved };
    });
  }

  public removeSavedSearch(ownerKey: string, id: string): Promise<boolean> {
    const cleanId = typeof id === 'string' ? id.trim() : '';
    if (!cleanId) throw new WriteValidationError('Saved search id is required', 400);
    return this.withOwnerLock(ownerKey, () => {
      const prefs = this.load(ownerKey);
      const next = prefs.savedSearches.filter((s) => s.id !== cleanId);
      if (next.length === prefs.savedSearches.length) return false;
      prefs.savedSearches = next;
      this.save(ownerKey, prefs);
      return true;
    });
  }

  public recordRecentRead(ownerKey: string, noteId: string, readAt = Date.now()): Promise<UserPreferences> {
    const id = assertValidId(noteId, 'note id');
    return this.withOwnerLock(ownerKey, () => {
      const prefs = this.load(ownerKey);
      const next = [{ noteId: id, readAt }, ...prefs.recentReads.filter((r) => r.noteId !== id)].slice(
        0,
        MAX_RECENT_READS
      );
      prefs.recentReads = next;
      this.save(ownerKey, prefs);
      return this.get(ownerKey);
    });
  }

  public setScratchpad(ownerKey: string, scratchpad: string): Promise<UserPreferences> {
    if (typeof scratchpad !== 'string') {
      throw new WriteValidationError('scratchpad must be a string', 400);
    }
    if (scratchpad.length > MAX_SCRATCHPAD_CHARS) {
      throw new WriteValidationError(`scratchpad exceeds ${MAX_SCRATCHPAD_CHARS} characters`, 400);
    }
    return this.withOwnerLock(ownerKey, () => {
      const prefs = this.load(ownerKey);
      if (prefs.scratchpad !== scratchpad) {
        prefs.scratchpad = scratchpad;
        this.save(ownerKey, prefs);
      }
      return this.get(ownerKey);
    });
  }
}
