/**
 * Search benchmark on a synthetic large account (~12k notes: ~5k scans whose body is only an
 * attachment link, ~1k long web clips, ~6k ordinary notes). Not part of the test suite.
 * Run: `npx tsx test/search-bench.ts` (JOPLIN_SERVER_URL is not used). Prints median timings and a
 * digest of each query's ordered `id:snippet` results, to check that a change keeps results identical.
 */
process.env.JOPLIN_SERVER_URL ||= 'http://127.0.0.1:1';

const { createHash } = await import('node:crypto');
const { noteCache } = await import('../src/services/note-cache.js');
const { JoplinItemType } = await import('../src/types/index.js');
type RawJoplinItem = import('../src/types/index.js').RawJoplinItem;
type ResourceMetadata = import('../src/types/index.js').ResourceMetadata;

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = makeRng(20261125);
const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];
const id = (key: string) => createHash('md5').update(`search-bench:${key}`).digest('hex');

const COMMON = [
  'Statement', 'Account', 'Balance', 'Invoice', 'Payment', 'Total', 'Amount', 'Date', 'Reference', 'Customer',
  'HSBC', 'Hang Seng', 'Standard Chartered', 'Insurance', 'Policy', 'Premium', 'Tax', 'Salary', 'Electricity',
  'Water', 'Bill', 'Receipt', 'Transfer', 'Deposit', 'Withdrawal', 'Interest', 'Credit', 'Debit', 'Card', 'Limit',
];
const SYL = ['ba', 'co', 'de', 'fi', 'ga', 'hu', 'ki', 'lo', 'ma', 'ne', 'po', 'ra', 'si', 'tu', 'vo', 'za', 'qu', 'ex', 'st', 'tr'];
const VOCAB: string[] = [];
for (let i = 0; i < 6000; i++) {
  const n = 2 + Math.floor(rng() * 3);
  let w = '';
  for (let j = 0; j < n; j++) w += pick(SYL);
  VOCAB.push(w);
}
const CJK = ['結單', '戶口', '結餘', '發票', '付款', '總額', '日期', '保險', '保單', '稅項', '銀行', '信用卡'];

function proseMarkdown(chars: number): string {
  const paras: string[] = [];
  let len = 0;
  while (len < chars) {
    const words: string[] = [];
    const n = 30 + Math.floor(rng() * 60);
    const cjk = rng() < 0.2;
    for (let i = 0; i < n; i++) {
      const r = rng();
      words.push(r < 0.05 ? pick(COMMON) : cjk && r < 0.1 ? pick(CJK) : pick(VOCAB));
    }
    const p = (rng() < 0.2 ? '## ' : rng() < 0.2 ? '- [link](https://example.com/x) **bold** ' : '') + words.join(' ') + '.';
    paras.push(p);
    len += p.length + 2;
  }
  return paras.join('\n\n');
}

const NOW = Date.UTC(2026, 10, 25);
const notebooks = new Map<string, RawJoplinItem>();
const notes = new Map<string, RawJoplinItem>();
const resources = new Map<string, ResourceMetadata>();
const tags = new Map<string, RawJoplinItem>();
const noteTags: Array<{ id: string; noteId: string; tagId: string }> = [];

const baseItem = (itemId: string, type: number, title: string, body: string, parentId: string, t: number, markup = '1'): RawJoplinItem => ({
  id: itemId, type_: type, title, body, parentId, createdTime: t, updatedTime: t + 1000, userCreatedTime: t,
  userUpdatedTime: t + 1000, deletedTime: 0, isTodo: false, todoDue: 0, todoCompleted: 0,
  properties: { markup_language: markup, encryption_applied: '0' },
});

const nbIds: string[] = [];
for (let i = 0; i < 60; i++) {
  const nbId = id(`nb${i}`);
  nbIds.push(nbId);
  notebooks.set(nbId, baseItem(nbId, JoplinItemType.Folder, i === 0 ? 'Pending to sort' : `Notebook ${i} ${pick(COMMON)}`, '', '', NOW));
}
const tagIds: string[] = [];
for (let i = 0; i < 40; i++) {
  const tagId = id(`tag${i}`);
  tagIds.push(tagId);
  tags.set(tagId, baseItem(tagId, JoplinItemType.Tag, i === 0 ? 'finance' : `tag-${pick(VOCAB)}`, '', '', NOW));
}

let bodyChars = 0;
function addScan(i: number, size: number) {
  const t = NOW - Math.floor(rng() * 3 * 365 * 86_400_000);
  const name = `${new Date(t).toISOString().replace(/[-:T]/g, '_').slice(0, 19)}.pdf`;
  const resId = id(`res${i}`);
  resources.set(resId, {
    id: resId, title: name, mime: 'application/pdf', filename: name, fileExtension: 'pdf', size, updatedTime: t,
  });
  const noteId = id(`scan${i}`);
  notes.set(noteId, baseItem(noteId, JoplinItemType.Note, name, `[${name}](:/${resId})`, rng() < 0.6 ? nbIds[0] : pick(nbIds), t));
}

let n = 0;
for (let i = 0; i < 5000; i++) addScan(n++, 20_000 + Math.floor(rng() * 2_000_000));
for (let i = 0; i < 1000; i++) {
  const t = NOW - Math.floor(rng() * 3 * 365 * 86_400_000);
  const noteId = id(`clip${i}`);
  const html = rng() < 0.3;
  const prose = proseMarkdown(20_000 + Math.floor(rng() * 60_000));
  const body = html ? `<div><p>${prose.replace(/\n\n/g, '</p><p>')}</p></div>` : prose;
  bodyChars += body.length;
  const note = baseItem(noteId, JoplinItemType.Note, `${pick(COMMON)} ${pick(VOCAB)} ${pick(VOCAB)}`, body, pick(nbIds), t, html ? '2' : '1');
  note.properties.source_url = `https://site${i % 50}.example.com/a/${i}`;
  notes.set(noteId, note);
}
for (let i = 0; i < 6000; i++) {
  const t = NOW - Math.floor(rng() * 3 * 365 * 86_400_000);
  const noteId = id(`note${i}`);
  let body = proseMarkdown(200 + Math.floor(rng() * 4000));
  if (rng() < 0.3) {
    const resId = id(`img${i}`);
    resources.set(resId, {
      id: resId, title: 'image.png', mime: 'image/png', filename: 'image.png', fileExtension: 'png', size: 50_000,
      updatedTime: t,
    });
    body += `\n\n![image.png](:/${resId})`;
  }
  bodyChars += body.length;
  notes.set(noteId, baseItem(noteId, JoplinItemType.Note, `${pick(COMMON)} ${pick(VOCAB)}`, body, pick(nbIds), t));
}
for (const noteId of notes.keys()) {
  if (rng() < 0.4) noteTags.push({ id: id(`nt${noteId}`), noteId, tagId: pick(tagIds) });
}

const sessionId = 'bench-session';
const caches = (noteCache as unknown as { caches: Map<string, unknown> }).caches;
caches.set(sessionId, {
  lastFetched: Date.now() + 365 * 86_400_000, lastAccessed: Date.now(), fetchPromise: null, lastRefreshFailed: false,
  notebooks, notes, tags, noteTags, resources, itemTimestamps: new Map(), syncInfoUpdatedTime: null,
  encryptedItemIds: new Set(), masterKeyIds: new Set(), unreadableItems: new Set(), localChanges: new Map(),
});

global.gc?.();
const mb = (b: number) => `${(b / 1048576).toFixed(0)} MB`;
console.log(
  `fixture: ${notes.size} notes, ${resources.size} resources, bodies ${(bodyChars / 1e6).toFixed(0)}M chars, heap ${mb(process.memoryUsage().heapUsed)}`
);

const QUERIES = (process.env.BENCH_QUERIES?.split('|') ?? [
  'ba',
  'invoice',
  'hsbc statement',
  '"account balance"',
  'zzqxv',
  '結單',
  'tag:finance',
  'notebook:"pending to sort" invoice',
  'invoice -insurance',
]);
const RUNS = Number(process.env.BENCH_RUNS || 5);

// Warm up the JIT
for (let i = 0; i < 2; i++) await noteCache.searchNotes(sessionId, 'warmup');

console.log('query'.padEnd(40), 'median ms'.padStart(10), 'min ms'.padStart(8), 'results'.padStart(8), 'json'.padStart(9), 'json ms'.padStart(8));
let firstIds = new Map<string, string>();
for (const q of QUERIES) {
  const times: number[] = [];
  let results: Awaited<ReturnType<typeof noteCache.searchNotes>> = [];
  for (let r = 0; r < RUNS; r++) {
    const t0 = performance.now();
    results = await noteCache.searchNotes(sessionId, q);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const t1 = performance.now();
  const json = JSON.stringify(results);
  const jsonMs = performance.now() - t1;
  firstIds.set(q, createHash('sha1').update(results.map((r) => `${r.id}:${r.matches.snippet}`).join(',')).digest('hex').slice(0, 10));
  console.log(
    q.padEnd(40),
    times[Math.floor(times.length / 2)].toFixed(1).padStart(10),
    times[0].toFixed(1).padStart(8),
    String(results.length).padStart(8),
    `${(json.length / 1024).toFixed(0)}K`.padStart(9),
    jsonMs.toFixed(1).padStart(8)
  );
}
console.log('result digests', JSON.stringify(Object.fromEntries(firstIds)));
global.gc?.();
console.log(`heap after: ${mb(process.memoryUsage().heapUsed)}`);

