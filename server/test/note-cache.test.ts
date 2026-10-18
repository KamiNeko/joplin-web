import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { MockItem } from '../demo/mock-joplin-server.js';
import { demoId } from '../demo/seed.js';
import { JoplinItemType, type RawJoplinItem } from '../src/types/index.js';
import { mockItem, putMockItem, startTestApp, type TestApp } from './helpers.js';

/**
 * Refresh behaviour of the note cache (issue #110): stale-while-revalidate for reads, blocking
 * refreshes for the first load, writes and forced refreshes, error handling of background
 * refreshes, the local-write guards, and the one-pass counts.
 *
 * The cache service is driven directly (same module instance as the running app) against the mock,
 * whose `onItemRequest` hook counts and holds Joplin Server requests.
 */

const TTL = 60_000;
const NOTE = demoId('note-roadmap');

let app: TestApp;
/** The note as seeded, restored before each test */
let seededNote: MockItem;
let noteCache: typeof import('../src/services/note-cache.js').noteCache;
let STALE_LIMIT_FACTOR: number;
let JoplinApiError: typeof import('../src/services/joplin-api.js').JoplinApiError;
let session: string;
const unhandled: unknown[] = [];
const onUnhandled = (err: unknown) => unhandled.push(err);

/** Counts root listings (first page) and content reads seen by the mock */
let listings = 0;
let contentReads: string[] = [];
/** Requests matching `holdWhen` wait until `release()` is called */
let holdWhen: ((r: { method: string; name: string; suffix: string }) => boolean) | null = null;
let held: Array<() => void> = [];
let heldSignal: (() => void) | null = null;

function release(): void {
  holdWhen = null;
  for (const resume of held.splice(0)) resume();
}

/** Holds matching requests and resolves once the first one has arrived */
function hold(match: (r: { method: string; name: string; suffix: string }) => boolean): Promise<void> {
  holdWhen = match;
  return new Promise((resolve) => (heldSignal = resolve));
}

const isListing = (r: { name: string; suffix: string }) => r.name === '' && r.suffix === '/children';

/** Resolves to 'pending' if `promise` hasn't settled after a short wait */
async function state(promise: Promise<unknown>): Promise<'settled' | 'pending'> {
  return Promise.race([
    promise.then(
      () => 'settled' as const,
      () => 'settled' as const
    ),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
  ]);
}

/** Makes the session's cache data `ms` old without touching its content */
async function ageCache(ms: number): Promise<void> {
  const entry = await noteCache.getEntry(session);
  entry.lastFetched = Date.now() - ms;
}

/** Changes a note's title on the mock, as another Joplin client would */
function retitleOnServer(id: string, title: string): void {
  const item = mockItem(app.mock, id)!;
  putMockItem(app.mock, { ...item, title, updatedTime: Date.now() });
}

/** Loads the session's cache, then resets the request counters */
async function loadCache(): Promise<void> {
  await noteCache.getNotes(session);
  listings = 0;
  contentReads = [];
}

async function noteTitle(id: string): Promise<string | undefined> {
  return (await noteCache.getNote(session, id))?.title;
}

before(async () => {
  process.on('unhandledRejection', onUnhandled);
  app = await startTestApp({ cacheTtlMs: TTL });
  ({ noteCache, STALE_LIMIT_FACTOR } = await import('../src/services/note-cache.js'));
  ({ JoplinApiError } = await import('../src/services/joplin-api.js'));
  seededNote = app.mock.items.get(`${NOTE}.md`)!;
  app.mock.onItemRequest = async (r) => {
    if (isListing(r)) listings++;
    if (r.suffix === '/content' && r.method === 'GET') contentReads.push(r.name);
    if (holdWhen?.(r)) {
      heldSignal?.();
      heldSignal = null;
      await new Promise<void>((resolve) => held.push(resolve));
    }
  };
});

after(async () => {
  release();
  process.off('unhandledRejection', onUnhandled);
  await app.close();
});

beforeEach(async () => {
  release();
  app.mock.items.set(`${NOTE}.md`, seededNote);
  // A fresh session per test, so each starts with an empty cache
  session = await app.login();
  listings = 0;
  contentReads = [];
});

describe('note cache refresh', () => {
  test('the first load waits for the listing', async () => {
    const listing = hold(isListing);
    const read = noteCache.getNotes(session);
    await listing;
    assert.equal(await state(read), 'pending');
    release();
    const notes = await read;
    assert.ok(notes.some((n) => n.id === NOTE));
    assert.equal(listings, 1);
  });

  test('within the TTL reads are served from the cache without any request', async () => {
    await loadCache();
    retitleOnServer(NOTE, 'Changed elsewhere');
    await noteCache.getNotes(session);
    await noteCache.getNotebooks(session);
    assert.equal(await noteTitle(NOTE), 'Website Relaunch Roadmap');
    assert.equal(listings, 0);
    assert.deepEqual(contentReads, []);
  });

  test('an expired cache serves stale data at once and refreshes in the background', async () => {
    await loadCache();
    await ageCache(TTL + 1000);
    retitleOnServer(NOTE, 'Changed elsewhere');

    const listing = hold(isListing);
    // These resolve while the listing is still held
    assert.equal(await noteTitle(NOTE), 'Website Relaunch Roadmap');
    await listing;
    await noteCache.getNotebooks(session);
    await noteCache.getTags(session);
    await noteCache.searchNotes(session, 'roadmap');
    assert.equal(listings, 1, 'concurrent reads share one background refresh');

    release();
    await noteCache.whenIdle(session);
    assert.equal(await noteTitle(NOTE), 'Changed elsewhere');
    assert.deepEqual(contentReads, [`${NOTE}.md`], 'only the changed item is re-read');
    assert.equal(listings, 1, 'the refreshed cache is fresh again');
  });

  test('data older than the stale limit is refreshed before the read answers', async () => {
    await noteCache.getNotes(session);
    await ageCache(TTL * STALE_LIMIT_FACTOR + 1000);
    retitleOnServer(NOTE, 'Changed long ago');

    const listing = hold(isListing);
    const read = noteTitle(NOTE);
    await listing;
    assert.equal(await state(read), 'pending');
    release();
    assert.equal(await read, 'Changed long ago');
  });

  test('the write path (getEntry) waits for an expired cache to refresh', async () => {
    await noteCache.getNotes(session);
    await ageCache(TTL + 1000);
    retitleOnServer(NOTE, 'Changed before a write');

    const listing = hold(isListing);
    const entryPromise = noteCache.getEntry(session);
    await listing;
    assert.equal(await state(entryPromise), 'pending');
    release();
    const entry = await entryPromise;
    assert.equal(entry.notes.get(NOTE)?.title, 'Changed before a write');
  });

  test('the write path joins a background refresh that is already running', async () => {
    await loadCache();
    await ageCache(TTL + 1000);
    retitleOnServer(NOTE, 'Changed during refresh');

    const listing = hold(isListing);
    await noteCache.getNotes(session); // starts the background refresh
    await listing;
    const entryPromise = noteCache.getEntry(session);
    assert.equal(await state(entryPromise), 'pending');
    release();
    assert.equal((await entryPromise).notes.get(NOTE)?.title, 'Changed during refresh');
    assert.equal(listings, 1);
  });

  test('a forced refresh waits even within the TTL', async () => {
    await noteCache.getNotes(session);
    retitleOnServer(NOTE, 'Changed, then refreshed');

    const listing = hold(isListing);
    const refresh = noteCache.refreshCache(session);
    await listing;
    assert.equal(await state(refresh), 'pending');
    release();
    await refresh;
    assert.equal(await noteTitle(NOTE), 'Changed, then refreshed');
  });

  test('a failed background refresh is handled, and the next read refreshes synchronously', async () => {
    await noteCache.getNotes(session);
    await ageCache(TTL + 1000);
    const unhandledBefore = unhandled.length;

    app.mock.failNextItemRequests(500);
    assert.equal(await noteTitle(NOTE), 'Website Relaunch Roadmap', 'stale data is still served');
    await noteCache.whenIdle(session);
    // Give a potential unhandled rejection a chance to surface
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandled.length, unhandledBefore, 'no unhandled rejection');

    listings = 0;
    retitleOnServer(NOTE, 'After the failure');
    const read = noteTitle(NOTE);
    assert.equal(await read, 'After the failure', 'the next read waited for a new refresh');
    assert.equal(listings, 1);
    assert.equal((await noteCache.getEntry(session)).lastRefreshFailed, false);
  });

  test('after a failed background refresh a persistent error reaches the caller', async () => {
    await noteCache.getNotes(session);
    await ageCache(TTL + 1000);
    const unhandledBefore = unhandled.length;

    app.mock.failNextItemRequests(500, 2);
    await noteCache.getNotes(session); // stale answer, the background refresh fails
    await noteCache.whenIdle(session);

    listings = 0;
    await assert.rejects(noteCache.getNotes(session), (err: unknown) => {
      assert.ok(err instanceof JoplinApiError);
      assert.equal(err.status, 500);
      return true;
    });

    // Joplin Server is back: the next read refreshes (synchronously) and succeeds
    retitleOnServer(NOTE, 'Back online');
    assert.equal(await noteTitle(NOTE), 'Back online');
    assert.equal(listings, 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandled.length, unhandledBefore, 'no unhandled rejection');
  });

  test('an expired session found by a background refresh signs the user out on the next request', async () => {
    const first = await app.api('/api/notes');
    assert.equal(first.status, 200);
    await ageCache(TTL + 1000);

    // The session ends on Joplin Server; the backend's auth cache still accepts it
    const logout = await fetch(`${app.mock.url}/logout`, {
      method: 'POST',
      headers: { 'X-API-AUTH': session },
      redirect: 'manual',
    });
    assert.equal(logout.status, 302);

    const stale = await app.api('/api/notes');
    assert.equal(stale.status, 200, 'the triggering request is answered from the cache');
    await noteCache.whenIdle(session);

    const next = await app.api('/api/notebooks');
    assert.equal(next.status, 401);
    const afterwards = await app.api('/api/tags');
    assert.equal(afterwards.status, 401, 'the session is marked invalid');
  });

  test('a background refresh does not overwrite a local write made while it ran', async () => {
    await noteCache.getNotes(session);
    const local: RawJoplinItem = { ...(await noteCache.getEntry(session)).notes.get(NOTE)!, title: 'Saved by Joplin Web' };
    await ageCache(TTL + 1000);
    retitleOnServer(NOTE, 'Older server version');

    const contentRead = hold((r) => r.method === 'GET' && r.name === `${NOTE}.md`);
    await noteCache.getNotes(session); // starts the background refresh
    await contentRead;

    // What the writer does after saving the note on Joplin Server
    noteCache.upsertItem(session, local);

    release();
    await noteCache.whenIdle(session);
    assert.equal(await noteTitle(NOTE), 'Saved by Joplin Web');
    const entry = await noteCache.getEntry(session);
    assert.ok(entry.itemTimestamps.get(`${NOTE}.md`)! < 0, 'keeps the local-write marker, so the next refresh re-reads it');
  });

  test('a background refresh keeps items created locally while its listing loaded', async () => {
    await noteCache.getNotes(session);
    const created: RawJoplinItem = {
      ...(await noteCache.getEntry(session)).notes.get(NOTE)!,
      id: 'abcdefabcdefabcdefabcdef0000a001',
      title: 'Created during the listing',
    };
    await ageCache(TTL + 1000);

    const listing = hold(isListing);
    await noteCache.getNotes(session);
    await listing;
    noteCache.upsertItem(session, created);

    release();
    await noteCache.whenIdle(session);
    assert.equal(await noteTitle(created.id), 'Created during the listing');
  });

  test('a background refresh removes items deleted on the server', async () => {
    await noteCache.getNotes(session);
    const saved = app.mock.items.get(`${NOTE}.md`)!;
    app.mock.items.delete(`${NOTE}.md`);
    try {
      await ageCache(TTL + 1000);
      await noteCache.getNotes(session);
      await noteCache.whenIdle(session);
      assert.equal(await noteCache.getNote(session, NOTE), null);
    } finally {
      app.mock.items.set(`${NOTE}.md`, saved);
    }
  });

  test('CACHE_TTL_MS=0 keeps reads synchronous', async () => {
    const { config } = await import('../src/config.js');
    const ttl = config.cacheTtlMs;
    config.cacheTtlMs = 0;
    try {
      await noteCache.getNotes(session);
      retitleOnServer(NOTE, 'Seen at once');
      await new Promise((resolve) => setTimeout(resolve, 2)); // data must be older than 0 ms
      assert.equal(await noteTitle(NOTE), 'Seen at once');
    } finally {
      config.cacheTtlMs = ttl;
    }
  });
});

describe('derived counts', () => {
  test('notebook note counts skip trashed notes and count each notebook directly', async () => {
    const notebookId = mockItem(app.mock, NOTE)!.parentId;
    const before = await noteCache.getNotebooks(session);
    const find = (nodes: typeof before, id: string): (typeof before)[number] | undefined => {
      for (const node of nodes) {
        if (node.id === id) return node;
        const child = find(node.children, id);
        if (child) return child;
      }
      return undefined;
    };
    const count = find(before, notebookId)!.noteCount;
    assert.ok(count >= 1);

    const trashed = 'abcdefabcdefabcdefabcdefabcdef02';
    const kept = 'abcdefabcdefabcdefabcdefabcdef03';
    const base = { type_: JoplinItemType.Note, parentId: notebookId, body: '', properties: { encryption_applied: '0' } };
    putMockItem(app.mock, { ...base, id: kept, title: 'Kept' });
    putMockItem(app.mock, {
      ...base,
      id: trashed,
      title: 'Trashed',
      properties: { ...base.properties, deleted_time: String(Date.now()) },
    });
    try {
      await noteCache.refreshCache(session);
      assert.equal(find(await noteCache.getNotebooks(session), notebookId)!.noteCount, count + 1);
    } finally {
      app.mock.items.delete(`${kept}.md`);
      app.mock.items.delete(`${trashed}.md`);
    }
  });

  test('tag counts count distinct active notes', async () => {
    const tags = await noteCache.getTags(session);
    const entry = await noteCache.getEntry(session);
    for (const tag of tags) {
      const expected = new Set(
        entry.noteTags
          .filter((l) => l.tagId === tag.id)
          .map((l) => entry.notes.get(l.noteId))
          .filter((n) => n && !(n.deletedTime > 0) && !((entry.notebooks.get(n.parentId)?.deletedTime ?? 0) > 0))
          .map((n) => n!.id)
      ).size;
      assert.equal(tag.noteCount, expected, tag.title);
    }
    assert.equal(tags.find((t) => t.title === 'cooking')?.noteCount, 2);
  });
});
