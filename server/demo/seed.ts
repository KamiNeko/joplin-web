import { createHash } from 'crypto';
import { serialize } from '../src/services/serializer.js';
import { JoplinItemType } from '../src/types/index.js';
import { syncTargetInfoItem, type MockItem } from './mock-joplin-server.js';

/**
 * Demo account and sample content for the mock Joplin Server.
 * Used by `npm run demo`, the README screenshots and the integration tests.
 */
export const DEMO_EMAIL = 'demo@joplin-web.test';
export const DEMO_PASSWORD = 'demo';

/** Stable 32-hex Joplin id derived from a readable key */
export const demoId = (key: string): string => createHash('md5').update(`joplin-web-demo:${key}`).digest('hex');

const HOUR = 60 * 60 * 1000;

const TRAM_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 420">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7cc4f2"/><stop offset="1" stop-color="#fde8c8"/>
    </linearGradient>
  </defs>
  <rect width="800" height="420" fill="url(#sky)"/>
  <circle cx="650" cy="90" r="42" fill="#fff4d6"/>
  <g fill="#f3d3b3" stroke="#d9a982" stroke-width="2">
    <rect x="20" y="150" width="140" height="200"/><rect x="170" y="110" width="120" height="240"/>
    <rect x="560" y="130" width="110" height="220"/><rect x="680" y="170" width="110" height="180"/>
  </g>
  <g fill="#e07a5f">
    <polygon points="20,150 90,115 160,150"/><polygon points="170,110 230,75 290,110"/>
    <polygon points="560,130 615,95 670,130"/><polygon points="680,170 735,140 790,170"/>
  </g>
  <g fill="#3d5a80" opacity="0.7">
    <rect x="45" y="190" width="30" height="40"/><rect x="105" y="190" width="30" height="40"/>
    <rect x="195" y="150" width="28" height="40"/><rect x="240" y="150" width="28" height="40"/>
    <rect x="590" y="170" width="28" height="40"/><rect x="710" y="210" width="28" height="40"/>
  </g>
  <rect x="0" y="350" width="800" height="70" fill="#8d99ae"/>
  <g stroke="#2b2d42" stroke-width="4"><line x1="0" y1="392" x2="800" y2="392"/><line x1="0" y1="404" x2="800" y2="404"/></g>
  <line x1="300" y1="40" x2="520" y2="40" stroke="#2b2d42" stroke-width="2"/>
  <line x1="410" y1="40" x2="410" y2="200" stroke="#2b2d42" stroke-width="3"/>
  <rect x="300" y="200" width="230" height="160" rx="22" fill="#f2c94c" stroke="#b8902a" stroke-width="3"/>
  <rect x="300" y="300" width="230" height="22" fill="#ffffff" opacity="0.85"/>
  <g fill="#cfe8f7" stroke="#2b2d42" stroke-width="2">
    <rect x="318" y="222" width="42" height="56" rx="6"/><rect x="372" y="222" width="42" height="56" rx="6"/>
    <rect x="426" y="222" width="42" height="56" rx="6"/><rect x="480" y="222" width="34" height="56" rx="6"/>
  </g>
  <text x="415" y="317" font-family="sans-serif" font-size="16" font-weight="bold" text-anchor="middle" fill="#2b2d42">28 · PRAZERES</text>
  <g fill="#2b2d42"><circle cx="350" cy="365" r="16"/><circle cx="480" cy="365" r="16"/></g>
</svg>`;

interface DemoNote {
  key: string;
  notebook: string;
  title: string;
  body: string;
  hoursAgo: number;
  tags?: string[];
  isTodo?: boolean;
  todoDueInHours?: number;
  completed?: boolean;
  deleted?: boolean;
  /** Key of the note this is a conflict copy of (`is_conflict: 1`), as Joplin creates on a sync conflict */
  conflictOf?: string;
  /** Body is HTML (`markup_language: 2`), like a page saved with the Joplin Web Clipper */
  html?: boolean;
}

const notebooks: Array<{ key: string; title: string; parent?: string }> = [
  { key: 'work', title: 'Work' },
  { key: 'projects', title: 'Projects', parent: 'work' },
  { key: 'meetings', title: 'Meeting Notes', parent: 'work' },
  { key: 'personal', title: 'Personal' },
  { key: 'recipes', title: 'Recipes', parent: 'personal' },
  { key: 'travel', title: 'Travel', parent: 'personal' },
  { key: 'reading', title: 'Reading List' },
];

const tags = ['planning', 'ideas', 'travel', 'cooking', 'books', 'important'];

const notes: DemoNote[] = [
  {
    key: 'roadmap',
    notebook: 'projects',
    title: 'Website Relaunch Roadmap',
    hoursAgo: 2,
    tags: ['planning', 'important'],
    body: `## Goals

Ship the new marketing site before the **end of Q4** with a faster, simpler stack.

| Milestone | Owner | Status |
| :--- | :--- | :---: |
| Content audit | Maya | ✅ Done |
| Design system | Jonas | 🚧 In progress |
| Static site build | Priya | ⏳ Next |
| Launch & redirects | Team | ⏳ Next |

## Open tasks

- [x] Collect analytics from the old site
- [x] Agree on the navigation structure
- [ ] Finish component library
- [ ] Write migration plan for blog posts

> Keep the scope small. Everything else goes into *phase two*.`,
  },
  {
    key: 'api-notes',
    notebook: 'projects',
    title: 'API Design Notes',
    hoursAgo: 26,
    tags: ['ideas'],
    body: `Notes on the public API for the booking service.

### Pagination

Use cursor based pagination instead of offsets:

\`\`\`ts
interface Page<T> {
  items: T[];
  cursor: string | null;
  hasMore: boolean;
}

async function* paginate<T>(fetchPage: (cursor?: string) => Promise<Page<T>>) {
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    yield* page.items;
    cursor = page.cursor ?? undefined;
  } while (cursor);
}
\`\`\`

### Errors

Return \`application/problem+json\` with a stable \`type\` URL for every error.`,
  },
  {
    key: 'weekly-sync',
    notebook: 'meetings',
    title: 'Weekly Sync — Design & Engineering',
    hoursAgo: 50,
    tags: ['planning'],
    body: `**Attendees:** Maya, Jonas, Priya

1. Design system tokens are ready for review
2. Build pipeline moved to the new runner, builds are ~40% faster
3. Accessibility audit scheduled for next week

**Decisions**

- Dark mode ships together with the relaunch
- Weekly sync moves to Thursdays`,
  },
  {
    key: 'lisbon',
    notebook: 'travel',
    title: 'Lisbon Long Weekend',
    hoursAgo: 5,
    tags: ['travel'],
    body: `![Tram 28 in Alfama](:/${demoId('res-tram')})

## Itinerary

| Day | Plan |
| :--- | :--- |
| Friday | Arrive, walk through Alfama, dinner in Graça |
| Saturday | Tram 28, Belém, pastéis de nata |
| Sunday | LX Factory, sunset at Miradouro da Senhora do Monte |

## Packing

- [x] Comfortable shoes (lots of hills!)
- [ ] Power adapter
- [ ] Rain jacket, just in case`,
  },
  {
    key: 'ramen',
    notebook: 'recipes',
    title: 'Weeknight Miso Ramen',
    hoursAgo: 30,
    tags: ['cooking'],
    body: `Ready in **25 minutes**, serves 2.

### Ingredients

- 2 portions fresh ramen noodles
- 800 ml vegetable stock
- 2 tbsp white miso
- 1 tbsp soy sauce, 1 tsp sesame oil
- Toppings: soft-boiled eggs, spring onions, corn, nori

### Steps

1. Bring the stock to a simmer, whisk in miso and soy sauce.
2. Cook the noodles separately, drain well.
3. Assemble bowls and add the toppings. Finish with sesame oil.`,
  },
  {
    key: 'sourdough',
    notebook: 'recipes',
    title: 'Sourdough Starter Schedule',
    hoursAgo: 120,
    tags: ['cooking'],
    body: `Feed the starter **1 : 1 : 1** (starter : flour : water) every 12 hours.

- Morning: feed at 8:00
- Evening: feed at 20:00
- Bake day: levain at 22:00 the night before`,
  },
  {
    key: 'deep-work',
    notebook: 'reading',
    title: 'Book Notes: Deep Work',
    hoursAgo: 72,
    tags: ['books'],
    body: `## Key ideas

- Focused work is a skill that can be trained
- Schedule *shallow work* into fixed blocks
- Embrace boredom instead of reaching for the phone

## Try this week

- [ ] Two 90-minute focus blocks per day
- [ ] No notifications before noon`,
  },
  {
    key: 'books-2026',
    notebook: 'reading',
    title: 'Books to Read in 2026',
    hoursAgo: 200,
    tags: ['books', 'ideas'],
    body: `1. *The Design of Everyday Things*
2. *A Philosophy of Software Design*
3. *Project Hail Mary*
4. *The Pragmatic Programmer*`,
  },
  {
    // Clipped pages are HTML notes: indentation after a blank line and *…* must stay plain HTML
    key: 'clipped-article',
    notebook: 'reading',
    title: 'Clipped: The Case for Slow Travel',
    hoursAgo: 150,
    tags: ['travel', 'books'],
    html: true,
    body: `<div class="clip">
  <h2>The Case for Slow Travel</h2>
  <p><em>Saved with the Joplin Web Clipper</em> from <a href="https://example.com/slow-travel">example.com</a></p>

    <p>Stay longer in fewer places. Take the *regional* train, not the _express_.</p>

  <img src=":/${demoId('res-tram')}" alt="Tram 28 in Alfama">
  <ul>
    <li>Rent a flat instead of a hotel room</li>
    <li>Pick one neighbourhood &amp; learn its bakeries</li>
  </ul>
  <p>Related: <a href=":/${demoId('note-lisbon')}">Lisbon Long Weekend</a></p>
</div>`,
  },
  {
    key: 'markdown-extras',
    notebook: 'work',
    title: 'Markdown Extras: Math, Diagrams & More',
    hoursAgo: 150,
    tags: ['ideas'],
    body: `Joplin's Markdown extensions, rendered like in the Joplin apps.

## Inline markup

- ==Highlighted== text and ++inserted++ text, next to ~~struck out~~ text
- Water is H~2~O, and E = mc^2^
- [ ] Check the ==release notes== for ~~old~~ ++new++ features

## Math

The roots of $ax^2 + bx + c = 0$ are

$$
x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}
$$

Amounts like $5 and $10 stay plain text.

## Diagram

\`\`\`mermaid
graph LR
  A[Draft] --> B{Review}
  B -->|Approved| C[Publish]
  B -->|Changes| A
\`\`\`
`,
  },
  {
    key: 'todo-passport',
    notebook: 'personal',
    title: 'Renew passport',
    hoursAgo: 8,
    isTodo: true,
    todoDueInHours: 24 * 9,
    tags: ['important'],
    body: 'Book an appointment at the citizen office and bring two biometric photos.',
  },
  {
    key: 'todo-bill',
    notebook: 'personal',
    title: 'Pay the electricity bill',
    hoursAgo: 50,
    isTodo: true,
    todoDueInHours: -30,
    body: 'Annual statement arrived; transfer the back payment.',
  },
  {
    key: 'todo-train',
    notebook: 'travel',
    title: 'Book train tickets to Porto',
    hoursAgo: 20,
    isTodo: true,
    completed: true,
    body: 'Alfa Pendular, Saturday morning. Window seats.',
  },
  {
    // The copy Joplin desktop keeps when a sync conflict happens: same notebook, flagged as a conflict
    key: 'roadmap-conflict',
    notebook: 'projects',
    conflictOf: 'roadmap',
    title: 'Website Relaunch Roadmap',
    hoursAgo: 3,
    body: `## Goals

Ship the new marketing site before the **end of Q4** with a faster, simpler stack.

## Open tasks

- [x] Collect analytics from the old site
- [ ] Finish component library
- [ ] Write migration plan for blog posts
- [ ] Ask legal about the cookie banner`,
  },
  {
    key: 'old-draft',
    notebook: 'projects',
    title: 'Old draft: landing page copy',
    hoursAgo: 300,
    deleted: true,
    body: 'Replaced by the new content plan.',
  },
];

function toItem(content: string | Buffer, updatedTime: number, contentType = 'text/plain; charset=utf-8'): MockItem {
  return { content: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'), contentType, updatedTime };
}

/** Builds the full set of demo items, keyed by item name as stored on Joplin Server */
export function buildDemoItems(now = Date.now()): Map<string, MockItem> {
  const items = new Map<string, MockItem>();
  const put = (id: string, content: string, time: number) => items.set(`${id}.md`, toItem(content, time));
  const base = now - 400 * HOUR;

  notebooks.forEach((nb, index) => {
    const id = demoId(`nb-${nb.key}`);
    put(
      id,
      serialize({
        type_: JoplinItemType.Folder,
        id,
        title: nb.title,
        parentId: nb.parent ? demoId(`nb-${nb.parent}`) : '',
        createdTime: base + index * 1000,
        updatedTime: base + index * 1000,
        properties: { deleted_time: '0', encryption_applied: '0', is_shared: '0', icon: '' },
      }),
      base + index * 1000
    );
  });

  for (const tag of tags) {
    const id = demoId(`tag-${tag}`);
    put(id, serialize({ type_: JoplinItemType.Tag, id, title: tag, createdTime: base, updatedTime: base }), base);
  }

  for (const note of notes) {
    const id = demoId(`note-${note.key}`);
    const updated = now - note.hoursAgo * HOUR;
    put(
      id,
      serialize({
        type_: JoplinItemType.Note,
        id,
        title: note.title,
        body: note.body,
        parentId: demoId(`nb-${note.notebook}`),
        createdTime: updated - 3 * HOUR,
        updatedTime: updated,
        isTodo: Boolean(note.isTodo),
        todoDue: note.todoDueInHours ? now + note.todoDueInHours * HOUR : 0,
        todoCompleted: note.completed ? updated : 0,
        properties: {
          deleted_time: note.deleted ? String(now - 4 * HOUR) : '0',
          markup_language: note.html ? '2' : '1',
          encryption_applied: '0',
          source: 'joplin-web-demo',
          ...(note.conflictOf
            ? { is_conflict: '1', conflict_original_id: demoId(`note-${note.conflictOf}`) }
            : {}),
        },
      }),
      updated
    );

    for (const tag of note.tags ?? []) {
      const linkId = demoId(`link-${note.key}-${tag}`);
      put(
        linkId,
        serialize({
          type_: JoplinItemType.NoteTag,
          id: linkId,
          createdTime: updated,
          updatedTime: updated,
          properties: { note_id: id, tag_id: demoId(`tag-${tag}`) },
        }),
        updated
      );
    }
  }

  const resId = demoId('res-tram');
  const svg = Buffer.from(TRAM_SVG, 'utf8');
  put(
    resId,
    serialize({
      type_: JoplinItemType.Resource,
      id: resId,
      title: 'tram-28.svg',
      createdTime: now - 5 * HOUR,
      updatedTime: now - 5 * HOUR,
      properties: {
        mime: 'image/svg+xml',
        filename: 'tram-28.svg',
        file_extension: 'svg',
        size: String(svg.length),
        encryption_applied: '0',
      },
    }),
    now - 5 * HOUR
  );
  items.set(`.resource/${resId}`, toItem(svg, now - 5 * HOUR, 'image/svg+xml'));

  // Every sync target written by Joplin 2.x/3.x has an info.json (sync version 3), here without E2EE
  items.set('info.json', syncTargetInfoItem(false, now - 400 * HOUR));

  return items;
}

/**
 * Serializes an item the way Joplin uploads it with E2EE on (`BaseItem.serializeForSync`): only
 * the keys needed to link and sync items stay in clear (`id`, `parent_id`, `note_id`, `tag_id`,
 * `updated_time`, `deleted_time`, `type_`), everything else (title, body, other properties) is in
 * `encryption_cipher_text`. The cipher text here is a placeholder; nothing can decrypt it.
 */
function encryptedItem(type: JoplinItemType, id: string, updatedTime: number, clear: Record<string, string> = {}): string {
  return serialize({
    type_: type,
    properties: {
      id,
      ...clear,
      updated_time: new Date(updatedTime).toISOString(),
      deleted_time: '0',
      encryption_cipher_text: `JED01000022${createHash('sha256').update(id).digest('hex')}`,
      encryption_applied: '1',
    },
  });
}

/**
 * The demo account with end-to-end encryption turned on: info.json says `e2ee: true`, plus an
 * encrypted notebook, encrypted notes (one inside a readable notebook), an encrypted tag and an
 * encrypted note-tag link, as Joplin desktop syncs them. Joplin Web shows such an account
 * read-only. Used by the tests and by `npm run demo` with `DEMO_E2EE=1`.
 */
export function buildEncryptedDemoItems(now = Date.now()): Map<string, MockItem> {
  const items = buildDemoItems(now);
  const put = (id: string, content: string, time: number) => items.set(`${id}.md`, toItem(content, time));
  const time = now - 2 * HOUR;

  const vault = demoId('nb-vault');
  put(vault, encryptedItem(JoplinItemType.Folder, vault, time, { parent_id: '' }), time);
  const secret = demoId('note-secret');
  put(secret, encryptedItem(JoplinItemType.Note, secret, time, { parent_id: vault }), time);
  const diary = demoId('note-diary');
  put(diary, encryptedItem(JoplinItemType.Note, diary, time + 1000, { parent_id: demoId('nb-personal') }), time + 1000);
  const tag = demoId('tag-private');
  put(tag, encryptedItem(JoplinItemType.Tag, tag, time), time);
  const link = demoId('link-diary-private');
  put(link, encryptedItem(JoplinItemType.NoteTag, link, time, { note_id: diary, tag_id: tag }), time);

  items.set('info.json', syncTargetInfoItem(true, now - HOUR));
  return items;
}
