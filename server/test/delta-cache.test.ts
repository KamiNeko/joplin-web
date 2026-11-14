import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { demoId } from '../demo/seed.js';
import { mockItem, putMockItem, startTestApp, type TestApp } from './helpers.js';

/**
 * Refreshes from Joplin Server's delta feed, and with CACHE_DIR one cache per user that is shared
 * by their sessions and survives a restart: only the first load of an account reads every item.
 */

const dir = mkdtempSync(join(tmpdir(), 'joplin-web-cache-'));
let app: TestApp;
let cacheModule: typeof import('../src/services/note-cache.js');
let listings = 0;
let reads: string[] = [];
const reset = () => {
  listings = 0;
  reads = [];
};
const titles = async (cache: InstanceType<typeof cacheModule.NoteCacheService>, session: string) =>
  new Map((await cache.getNotes(session)).map((n) => [n.id, n.title]));

before(async () => {
  app = await startTestApp({ delta: true, cacheDir: dir });
  cacheModule = await import('../src/services/note-cache.js');
  app.mock.onItemRequest = ({ name, suffix }) => {
    if (name === '' && suffix === '/children') listings++;
    else if (suffix === '/content') reads.push(name);
  };
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test('delta refresh, shared and saved per-user cache, expired cursor', async () => {
  const { noteCache, NoteCacheService } = cacheModule;
  const first = await app.login();
  const before = await titles(noteCache, first);
  assert.equal(listings, 1, 'the first load lists the account');
  reset();

  await noteCache.refreshCache(first);
  assert.deepEqual([listings, reads], [0, []], 'nothing changed: no listing, no reads');

  const retitled = demoId('note-roadmap');
  const deleted = demoId('note-lisbon');
  putMockItem(app.mock, { ...mockItem(app.mock, retitled)!, title: 'Retitled elsewhere' });
  app.mock.recordChange(`${retitled}.md`, 2);
  app.mock.items.delete(`${deleted}.md`);
  app.mock.recordChange(`${deleted}.md`, 3);
  await noteCache.refreshCache(first);
  assert.deepEqual([listings, reads], [0, [`${retitled}.md`]], 'only the changed note is read');
  const after = await titles(noteCache, first);
  assert.equal(after.get(retitled), 'Retitled elsewhere');
  assert.ok(before.has(deleted) && !after.has(deleted), 'the deleted note is gone');
  reset();

  const second = await app.login();
  assert.equal((await titles(noteCache, second)).get(retitled), 'Retitled elsewhere');
  assert.deepEqual([listings, reads], [0, []], 'a second login of the user reuses the cache');

  const restarted = new NoteCacheService();
  assert.equal((await titles(restarted, second)).get(retitled), 'Retitled elsewhere');
  assert.deepEqual([listings, reads], [0, []], 'a restart loads the saved cache');

  app.mock.expireCursors();
  await noteCache.refreshCache(first);
  assert.deepEqual([listings, reads], [1, []], 'an expired cursor re-lists but reads nothing unchanged');
  reset();
  await noteCache.refreshCache(first);
  assert.equal(listings, 0, 'and the delta feed is used again afterwards');

  noteCache.clearCache(second);
  assert.equal(noteCache.hasCache(first), true, 'logging out one session keeps the user cache');
});
