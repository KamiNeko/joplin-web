import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { deserialize, markupLanguageOf, notePreview, serialize, stripHtml, stripMarkdown } from '../src/services/serializer.js';
import { JoplinItemType } from '../src/types/index.js';

/**
 * Offline tests for the Joplin sync-format serializer (no server required).
 *
 * CRLF line endings are covered separately by #47.
 */

const NOTE_ID = 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6';
const FOLDER_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

const baseProps = {
  id: NOTE_ID,
  parent_id: FOLDER_ID,
  created_time: '2026-10-17T16:00:00.000Z',
  updated_time: '2026-10-17T16:05:00.000Z',
  is_todo: '0',
  deleted_time: '0',
};

/** Serializes the way NoteWriterService.write does (only type_, title, body and properties) */
function roundTrip(item: { type_: number; title?: string; body?: string; properties: Record<string, string> }) {
  return deserialize(serialize(item));
}

/** Round-trips a single property value through a note */
function roundTripValue(value: string): string {
  return roundTrip({ type_: JoplinItemType.Note, title: 'T', body: 'B', properties: { ...baseProps, value } }).properties.value;
}

describe('note title and body', () => {
  test('multi-line body with blank lines round-trips unchanged', () => {
    const body = '# Heading\n\nParagraph one.\n\n\n- item\n\n```js\nconst x = 1;\n```\n';
    const out = roundTrip({ type_: JoplinItemType.Note, title: 'Title', body, properties: baseProps });
    assert.equal(out.title, 'Title');
    assert.equal(out.body, body);
  });

  test('empty title keeps the body intact', () => {
    const out = roundTrip({ type_: JoplinItemType.Note, title: '', body: 'First line\nSecond', properties: baseProps });
    assert.equal(out.title, '');
    assert.equal(out.body, 'First line\nSecond');
  });

  test('empty body round-trips', () => {
    const out = roundTrip({ type_: JoplinItemType.Note, title: 'Only title', body: '', properties: baseProps });
    assert.equal(out.title, 'Only title');
    assert.equal(out.body, '');
  });

  test('empty title and empty body round-trip', () => {
    const serialized = serialize({ type_: JoplinItemType.Note, title: '', body: '', properties: baseProps });
    assert.ok(serialized.startsWith('\n\nid: '), 'empty title line is still written');
    const out = deserialize(serialized);
    assert.equal(out.title, '');
    assert.equal(out.body, '');
    assert.equal(out.id, NOTE_ID);
  });

  test('multi-line title is flattened', () => {
    const out = roundTrip({ type_: JoplinItemType.Note, title: 'Line 1\nLine 2', body: 'x', properties: baseProps });
    assert.equal(out.title, 'Line 1 Line 2');
    assert.equal(out.body, 'x');
  });

  test('body with leading blank lines round-trips', () => {
    const body = '\n\nStarts after two blank lines';
    assert.equal(roundTrip({ type_: JoplinItemType.Note, title: 'T', body, properties: baseProps }).body, body);
  });

  test('body with trailing blank lines round-trips', () => {
    const body = 'Ends with blank lines\n\n\n';
    assert.equal(roundTrip({ type_: JoplinItemType.Note, title: 'T', body, properties: baseProps }).body, body);
  });

  test('trailing whitespace in the title and body lines is kept', () => {
    const body = 'two trailing spaces make a line break  \nnext line\t\n   ';
    const out = roundTrip({ type_: JoplinItemType.Note, title: 'Title  ', body, properties: baseProps });
    assert.equal(out.title, 'Title  ');
    assert.equal(out.body, body);
  });

  test('body whose last paragraph looks like a property stays in the body', () => {
    const body = 'Intro\n\nauthor: Jane\nsource_url: https://example.com/x';
    const out = roundTrip({ type_: JoplinItemType.Note, title: 'T', body, properties: baseProps });
    assert.equal(out.body, body);
    assert.equal(out.properties.author, undefined);
    assert.equal(out.properties.source_url, undefined);
  });

  test('body containing escape-like sequences is not unescaped', () => {
    const body = 'C string: "a\\nb", path C:\\new\\rules, literal \\\\n';
    assert.equal(roundTrip({ type_: JoplinItemType.Note, title: 'T', body, properties: baseProps }).body, body);
  });

  test('unicode title and body round-trip', () => {
    const title = 'Ünïcödé 🎉 日本語 עברית';
    const body = 'Emoji 👩‍👩‍👧‍👦, combining e\u0301, CJK 漢字, RTL שלום, zero-width\u200bspace';
    const out = roundTrip({ type_: JoplinItemType.Note, title, body, properties: baseProps });
    assert.equal(out.title, title);
    assert.equal(out.body, body);
  });

  test('a lone title line is read as the title', () => {
    const out = deserialize(`Just a title\n\nid: ${NOTE_ID}\ntype_: 1`);
    assert.equal(out.title, 'Just a title');
    assert.equal(out.body, '');
  });

  test('body directly after the title (no blank separator) is accepted', () => {
    const out = deserialize(`Title\nBody line\n\nid: ${NOTE_ID}\ntype_: 1`);
    assert.equal(out.title, 'Title');
    assert.equal(out.body, 'Body line');
  });
});

describe('property values', () => {
  test('unknown properties round-trip', () => {
    const props = { ...baseProps, custom_field: 'keep me', x_future: '{"a":1}' };
    const out = roundTrip({ type_: JoplinItemType.Note, title: 'T', body: 'B', properties: props });
    assert.equal(out.properties.custom_field, 'keep me');
    assert.equal(out.properties.x_future, '{"a":1}');
    assert.equal(out.parentId, FOLDER_ID);
  });

  test('every property survives a round trip', () => {
    const props = { ...baseProps, author: 'Jane', source_url: 'https://example.com', custom: 'x' };
    const out = roundTrip({ type_: JoplinItemType.Note, title: 'T', body: 'B', properties: props });
    for (const [key, value] of Object.entries(props)) assert.equal(out.properties[key], value, key);
    assert.equal(out.properties.type_, '1');
  });

  test('newlines in values are escaped and restored', () => {
    assert.equal(roundTripValue('a\nb'), 'a\nb');
    assert.equal(roundTripValue('a\n\nb\n'.trim()), 'a\n\nb');
    const serialized = serialize({ type_: JoplinItemType.Note, title: 'T', body: '', properties: { value: 'a\nb' } });
    assert.ok(serialized.includes('value: a\\nb'), 'written as a single line');
  });

  test('carriage returns in values are escaped and restored', () => {
    assert.equal(roundTripValue('a\rb'), 'a\rb');
    assert.equal(roundTripValue('a\r\nb'), 'a\r\nb');
  });

  test('literal backslash sequences in values round-trip', () => {
    // As characters: a, backslash, n, b (not a newline)
    assert.equal(roundTripValue('a\\nb'), 'a\\nb');
    assert.equal(roundTripValue('a\\rb'), 'a\\rb');
    assert.equal(roundTripValue('a\\\\nb'), 'a\\\\nb');
    assert.equal(roundTripValue('C:\\new\\folder'), 'C:\\new\\folder');
    assert.equal(roundTripValue('mixed \\n and\nreal'), 'mixed \\n and\nreal');
  });

  test('a backslash before a real newline reads back as a literal \\n, like Joplin (#55)', () => {
    // Joplin's BaseItem escaping is lossy here too; serializer-fidelity.test.ts compares it in full
    assert.equal(roundTripValue('a\\\nb'), 'a\\nb');
  });

  test('values containing colons are split at the first colon only', () => {
    assert.equal(roundTripValue('https://example.com:8080/a?b=c'), 'https://example.com:8080/a?b=c');
    const out = deserialize(`T\n\nsource_url: https://example.com:8080/x\nkey:no-space\ntype_: 1`);
    assert.equal(out.properties.source_url, 'https://example.com:8080/x');
    assert.equal(out.properties.key, 'no-space');
  });

  test('empty values round-trip as empty strings', () => {
    const props = { ...baseProps, author: '', source_url: '', share_id: '' };
    const serialized = serialize({ type_: JoplinItemType.Note, title: 'T', body: 'B', properties: props });
    assert.ok(serialized.includes('\nauthor: \n'), 'written as "key: "');
    const out = deserialize(serialized);
    assert.equal(out.properties.author, '');
    assert.equal(out.properties.share_id, '');
  });

  test('null and undefined values are written as empty strings', () => {
    const out = roundTrip({
      type_: JoplinItemType.Note,
      title: 'T',
      body: '',
      properties: { ...baseProps, a: null as unknown as string, b: undefined as unknown as string },
    });
    assert.equal(out.properties.a, '');
    assert.equal(out.properties.b, '');
  });

  test('leading and trailing whitespace in values is trimmed', () => {
    assert.equal(roundTripValue('  x'), 'x');
    assert.equal(roundTripValue('x  '), 'x');
    assert.equal(roundTripValue(' \t x y \t '), 'x y');
    const out = deserialize(`T\n\n  padded_key  :   value  \ntype_: 1`);
    assert.equal(out.properties.padded_key, 'value');
  });

  test('unicode values round-trip', () => {
    assert.equal(roundTripValue('Jürgen 🎉 東京'), 'Jürgen 🎉 東京');
    assert.equal(roundTripValue('{"emoji":"📦","name":"package"}'), '{"emoji":"📦","name":"package"}');
  });

  test('title and body keys in properties are not written', () => {
    const serialized = serialize({ type_: JoplinItemType.Note, title: 'T', body: 'B', properties: { ...baseProps, title: 'x', body: 'y' } });
    assert.ok(!/^title: /m.test(serialized));
    assert.ok(!/^body: /m.test(serialized));
  });
});

describe('item types', () => {
  test('folders have a title but no body', () => {
    const out = roundTrip({ type_: JoplinItemType.Folder, title: 'Notebook', body: 'ignored', properties: { id: NOTE_ID, parent_id: '' } });
    assert.equal(out.type_, JoplinItemType.Folder);
    assert.equal(out.title, 'Notebook');
    assert.equal(out.body, '');
  });

  test('note-tag links have no title line, only properties', () => {
    const props = { id: NOTE_ID, note_id: 'a'.repeat(32), tag_id: 'b'.repeat(32) };
    const serialized = serialize({ type_: JoplinItemType.NoteTag, body: '', properties: props });
    assert.ok(!serialized.startsWith('\n'));
    assert.equal(serialized.split('\n')[0], `id: ${NOTE_ID}`);
    const out = deserialize(serialized);
    assert.equal(out.type_, JoplinItemType.NoteTag);
    assert.equal(out.properties.note_id, props.note_id);
    assert.equal(out.properties.tag_id, props.tag_id);
  });

  test('tags keep their title and drop the body', () => {
    const out = roundTrip({ type_: JoplinItemType.Tag, title: 'important', body: 'ignored', properties: { id: NOTE_ID, parent_id: '' } });
    assert.equal(out.type_, JoplinItemType.Tag);
    assert.equal(out.title, 'important');
    assert.equal(out.body, '');
  });

  test('resources keep title, mime, size and encryption flags', () => {
    const props = {
      id: NOTE_ID,
      mime: 'image/png',
      filename: 'pixel.png',
      file_extension: 'png',
      size: '12345',
      encryption_blob_encrypted: '0',
      ocr_text: '',
    };
    const out = roundTrip({ type_: JoplinItemType.Resource, title: 'pixel.png', body: 'ignored', properties: props });
    assert.equal(out.type_, JoplinItemType.Resource);
    assert.equal(out.title, 'pixel.png');
    assert.equal(out.body, '');
    for (const [key, value] of Object.entries(props)) assert.equal(out.properties[key], value, key);
  });

  test('encrypted items keep their cipher text byte for byte', () => {
    const cipher = 'JED01000022' + Array.from({ length: 4000 }, (_, i) => 'abcdef0123456789+/='[i % 19]).join('');
    const raw = `\n\nid: ${NOTE_ID}\nparent_id: ${FOLDER_ID}\nencryption_cipher_text: ${cipher}\nencryption_applied: 1\nis_shared: 0\ntype_: 1`;
    const item = deserialize(raw);
    assert.equal(item.properties.encryption_applied, '1');
    assert.equal(item.properties.encryption_cipher_text, cipher);
    const again = deserialize(serialize({ type_: item.type_, title: item.title, body: item.body, properties: item.properties }));
    assert.equal(again.properties.encryption_cipher_text, cipher);
    assert.equal(again.properties.encryption_applied, '1');
    assert.equal(again.title, '');
    assert.equal(again.body, '');
  });

  test('missing type_ defaults to a note', () => {
    const out = deserialize(`T\n\nB\n\nid: ${NOTE_ID}`);
    assert.equal(out.type_, JoplinItemType.Note);
    assert.equal(out.body, 'B');
  });
});

describe('fallbacks', () => {
  test('title falls back to the title property', () => {
    const out = deserialize(`\n\nid: ${NOTE_ID}\ntitle: From property\ntype_: 1`);
    assert.equal(out.title, 'From property');
  });

  test('id falls back to the file name', () => {
    assert.equal(deserialize('T\n\ntype_: 1', `${NOTE_ID}.md`).id, NOTE_ID);
    assert.equal(deserialize('T\n\ntype_: 1', `${NOTE_ID}.MD`).id, NOTE_ID);
    assert.equal(deserialize(`T\n\nid: ${FOLDER_ID}\ntype_: 1`, `${NOTE_ID}.md`).id, FOLDER_ID, 'id property wins');
    assert.equal(deserialize('T\n\ntype_: 1').id, '');
  });

  test('rejects non-string content', () => {
    assert.throws(() => deserialize(undefined as unknown as string), /non-string/);
  });
});

describe('timestamps', () => {
  test('ISO, numeric and invalid timestamps are parsed', () => {
    const out = deserialize(
      `T\n\ncreated_time: 2026-10-17T16:00:00.000Z\nupdated_time: 1792256400000\ndeleted_time: not a date\ntype_: 1`
    );
    assert.equal(out.createdTime, Date.parse('2026-10-17T16:00:00.000Z'));
    assert.equal(out.updatedTime, 1792256400000);
    assert.equal(out.deletedTime, 0);
  });

  test('deleted_time is kept as epoch milliseconds', () => {
    const out = roundTrip({ type_: JoplinItemType.Note, title: 'T', body: '', properties: { ...baseProps, deleted_time: '1792256400000' } });
    assert.equal(out.deletedTime, 1792256400000);
  });

  test('user_* and plain timestamps fall back to each other', () => {
    const onlyUser = deserialize(
      `T\n\nuser_created_time: 2026-01-01T00:00:00.000Z\nuser_updated_time: 2026-01-02T00:00:00.000Z\ntype_: 1`
    );
    assert.equal(onlyUser.createdTime, Date.parse('2026-01-01T00:00:00.000Z'));
    assert.equal(onlyUser.updatedTime, Date.parse('2026-01-02T00:00:00.000Z'));

    const onlyPlain = deserialize(`T\n\ncreated_time: 2026-01-03T00:00:00.000Z\nupdated_time: 2026-01-04T00:00:00.000Z\ntype_: 1`);
    assert.equal(onlyPlain.userCreatedTime, Date.parse('2026-01-03T00:00:00.000Z'));
    assert.equal(onlyPlain.userUpdatedTime, Date.parse('2026-01-04T00:00:00.000Z'));

    const none = deserialize('T\n\ntype_: 1');
    assert.equal(none.createdTime, 0);
    assert.equal(none.userUpdatedTime, 0);
  });

  test('serialize writes timestamps as ISO strings', () => {
    const serialized = serialize({ type_: JoplinItemType.Note, id: NOTE_ID, title: 'T', createdTime: 1792256400000, updatedTime: '2026-10-17T16:05:00.000Z' });
    assert.match(serialized, /^created_time: 2026-10-17T\d\d:00:00\.000Z$/m);
    assert.match(serialized, /^updated_time: 2026-10-17T16:05:00\.000Z$/m);
    assert.match(serialized, /^user_created_time: 2026-10-17T\d\d:00:00\.000Z$/m, 'user_created_time defaults to created_time');
    assert.match(serialized, /^user_updated_time: 2026-10-17T16:05:00\.000Z$/m);
    assert.equal(deserialize(serialized).createdTime, 1792256400000);
  });

  test('serialize writes empty values for zero or invalid timestamps', () => {
    const serialized = serialize({ type_: JoplinItemType.Note, title: 'T', createdTime: 0, updatedTime: 'garbage' });
    assert.match(serialized, /^created_time: $/m);
    assert.match(serialized, /^updated_time: $/m);
  });
});

describe('to-dos', () => {
  test('to-do fields are serialized and parsed', () => {
    const serialized = serialize({ type_: JoplinItemType.Note, title: 'Buy milk', isTodo: true, todoDue: 1792256400000, todoCompleted: 0 });
    assert.match(serialized, /^is_todo: 1$/m);
    assert.match(serialized, /^todo_due: 1792256400000$/m);
    assert.match(serialized, /^todo_completed: 0$/m);
    const out = deserialize(serialized);
    assert.equal(out.isTodo, true);
    assert.equal(out.todoDue, 1792256400000);
    assert.equal(out.todoCompleted, 0);
  });

  test('snake_case to-do fields are accepted', () => {
    const out = deserialize(serialize({ type_: JoplinItemType.Note, title: 'T', is_todo: 1, todo_due: 5, todo_completed: 7 }));
    assert.equal(out.isTodo, true);
    assert.equal(out.todoDue, 5);
    assert.equal(out.todoCompleted, 7);
    assert.equal(deserialize(serialize({ type_: JoplinItemType.Note, title: 'T', is_todo: false })).isTodo, false);
  });

  test('regular notes are not to-dos', () => {
    const out = roundTrip({ type_: JoplinItemType.Note, title: 'T', body: '', properties: baseProps });
    assert.equal(out.isTodo, false);
    assert.equal(out.todoDue, 0);
    assert.equal(out.todoCompleted, 0);
  });
});

describe('wire format', () => {
  // Items as Joplin desktop writes them to the sync target
  const fixtures: Record<string, string> = {
    note: [
      'Shopping list',
      '',
      '- milk\n- eggs\n\nSecond paragraph',
      '',
      `id: ${NOTE_ID}`,
      `parent_id: ${FOLDER_ID}`,
      'created_time: 2026-10-17T16:00:00.000Z',
      'updated_time: 2026-10-17T16:05:00.000Z',
      'is_conflict: 0',
      'latitude: 0.00000000',
      'longitude: 0.00000000',
      'altitude: 0.0000',
      'author: ',
      'source_url: https://example.com:8080/a',
      'is_todo: 0',
      'todo_due: 0',
      'todo_completed: 0',
      'source: joplin-desktop',
      'source_application: net.cozic.joplin-desktop',
      'application_data: ',
      'order: 0',
      'user_created_time: 2026-10-17T16:00:00.000Z',
      'user_updated_time: 2026-10-17T16:05:00.000Z',
      'encryption_cipher_text: ',
      'encryption_applied: 0',
      'markup_language: 1',
      'is_shared: 0',
      'share_id: ',
      'conflict_original_id: ',
      'master_key_id: ',
      'user_data: ',
      'deleted_time: 0',
      'type_: 1',
    ].join('\n'),
    todo: [
      'Renew passport',
      '',
      `id: ${NOTE_ID}`,
      `parent_id: ${FOLDER_ID}`,
      'created_time: 2026-10-17T16:00:00.000Z',
      'updated_time: 2026-10-17T16:05:00.000Z',
      'is_todo: 1',
      'todo_due: 1792256400000',
      'todo_completed: 0',
      'user_created_time: 2026-10-17T16:00:00.000Z',
      'user_updated_time: 2026-10-17T16:05:00.000Z',
      'deleted_time: 0',
      'type_: 1',
    ].join('\n'),
    folder: [
      'Work',
      '',
      `id: ${FOLDER_ID}`,
      'created_time: 2026-10-17T16:00:00.000Z',
      'updated_time: 2026-10-17T16:05:00.000Z',
      'user_created_time: 2026-10-17T16:00:00.000Z',
      'user_updated_time: 2026-10-17T16:05:00.000Z',
      'encryption_cipher_text: ',
      'encryption_applied: 0',
      'parent_id: ',
      'is_shared: 0',
      'share_id: ',
      'master_key_id: ',
      'icon: {"emoji":"💼","name":"briefcase","type":1}',
      'user_data: ',
      'deleted_time: 0',
      'type_: 2',
    ].join('\n'),
    tag: [
      'important',
      '',
      `id: ${NOTE_ID}`,
      'created_time: 2026-10-17T16:00:00.000Z',
      'updated_time: 2026-10-17T16:05:00.000Z',
      'user_created_time: 2026-10-17T16:00:00.000Z',
      'user_updated_time: 2026-10-17T16:05:00.000Z',
      'encryption_cipher_text: ',
      'encryption_applied: 0',
      'is_shared: 0',
      'parent_id: ',
      'user_data: ',
      'type_: 5',
    ].join('\n'),
    note_tag: [
      `id: ${NOTE_ID}`,
      `note_id: ${'c'.repeat(32)}`,
      `tag_id: ${'d'.repeat(32)}`,
      'created_time: 2026-10-17T16:00:00.000Z',
      'updated_time: 2026-10-17T16:05:00.000Z',
      'user_created_time: 2026-10-17T16:00:00.000Z',
      'user_updated_time: 2026-10-17T16:05:00.000Z',
      'encryption_cipher_text: ',
      'encryption_applied: 0',
      'is_shared: 0',
      'type_: 6',
    ].join('\n'),
    resource: [
      'pixel.png',
      '',
      `id: ${NOTE_ID}`,
      'mime: image/png',
      'filename: ',
      'created_time: 2026-10-17T16:00:00.000Z',
      'updated_time: 2026-10-17T16:05:00.000Z',
      'user_created_time: 2026-10-17T16:00:00.000Z',
      'user_updated_time: 2026-10-17T16:05:00.000Z',
      'file_extension: png',
      'encryption_cipher_text: ',
      'encryption_applied: 0',
      'encryption_blob_encrypted: 0',
      'size: 12345',
      'is_shared: 0',
      'share_id: ',
      'master_key_id: ',
      'user_data: ',
      'blob_updated_time: 1792256400000',
      'ocr_text: ',
      'type_: 4',
    ].join('\n'),
  };

  /** Note-tag links have no title line, so they are written with title undefined, as NoteWriterService does */
  const titleFor = (item: { type_: number; title: string }) => (item.type_ === JoplinItemType.NoteTag ? undefined : item.title);

  for (const [name, raw] of Object.entries(fixtures)) {
    test(`${name}: deserialize then serialize keeps every value`, () => {
      const item = deserialize(raw);
      const out = deserialize(serialize({ type_: item.type_, title: titleFor(item), body: item.body, properties: item.properties }));
      assert.equal(out.title, item.title);
      assert.equal(out.body, item.body);
      assert.deepEqual(out.properties, item.properties);
    });

    test(`${name}: serialize(deserialize(raw)) reproduces the raw text`, () => {
      const item = deserialize(raw);
      assert.equal(serialize({ type_: item.type_, title: titleFor(item), body: item.body, properties: item.properties }), raw);
    });
  }

  test('fixtures parse into the expected items', () => {
    assert.equal(deserialize(fixtures.note).body, '- milk\n- eggs\n\nSecond paragraph');
    assert.equal(deserialize(fixtures.note).properties.source_url, 'https://example.com:8080/a');
    assert.equal(deserialize(fixtures.todo).isTodo, true);
    assert.equal(deserialize(fixtures.folder).properties.icon, '{"emoji":"💼","name":"briefcase","type":1}');
    assert.equal(deserialize(fixtures.tag).title, 'important');
    assert.equal(deserialize(fixtures.note_tag).title, '');
    assert.equal(deserialize(fixtures.note_tag).properties.tag_id, 'd'.repeat(32));
    assert.equal(deserialize(fixtures.resource).properties.size, '12345');
  });
});

describe('stripMarkdown', () => {
  test('removes table pipes and separators', () => {
    assert.equal(stripMarkdown('Intro\n\n| Day | Plan |\n| :--- | :---: |\n| Fri | Arrive |'), 'Intro Day Plan Fri Arrive');
  });

  test('removes code blocks and images, keeps link labels and inline code', () => {
    const md = '# Title\n\nSee [the docs](https://example.com) and `npm test`.\n\n```js\nsecret();\n```\n\n![diagram](:/abc)\n> quoted **bold** _it_ ~~gone~~';
    assert.equal(stripMarkdown(md), 'Title See the docs and npm test. quoted bold it gone');
  });

  test('removes list markers, rules and HTML tags', () => {
    assert.equal(stripMarkdown('- one\n* two\n1. three\n\n---\n<b>html</b>'), 'one two three html');
  });

  test('returns an empty string for empty input', () => {
    assert.equal(stripMarkdown(''), '');
    assert.equal(stripMarkdown(undefined), '');
  });

  test('keeps text at or below the limit unchanged', () => {
    assert.equal(stripMarkdown('a'.repeat(150)), 'a'.repeat(150));
  });

  test('truncates at a word boundary with an ellipsis', () => {
    const text = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const preview = stripMarkdown(text, 50);
    assert.ok(preview.endsWith('...'));
    const visible = preview.slice(0, -3);
    assert.ok(visible.length <= 50);
    assert.ok(text.startsWith(visible));
    assert.ok(text.charAt(visible.length) === ' ', 'cut before a space');
  });

  test('truncates mid-word when there is no late word boundary', () => {
    assert.equal(stripMarkdown('a'.repeat(200), 10), `${'a'.repeat(10)}...`);
    assert.equal(stripMarkdown(`ab ${'c'.repeat(100)}`, 10), `ab ${'c'.repeat(7)}...`);
  });
});

describe('HTML notes', () => {
  const html = '<div class="clip">\n  <p>Intro</p>\n\n    <p>After blank line, *indented*</p>\n</div>';

  test('round-trips an HTML note body and markup_language unchanged', () => {
    const parsed = roundTrip({ type_: JoplinItemType.Note, title: 'Clip', body: html, properties: { ...baseProps, markup_language: '2' } });
    assert.equal(parsed.body, html);
    assert.equal(parsed.properties.markup_language, '2');
    assert.equal(markupLanguageOf(parsed.properties), 2);
  });

  test('treats missing or unknown markup_language as Markdown', () => {
    assert.equal(markupLanguageOf({}), 1);
    assert.equal(markupLanguageOf(undefined), 1);
    assert.equal(markupLanguageOf({ markup_language: '1' }), 1);
    assert.equal(markupLanguageOf({ markup_language: '7' }), 1);
  });

  test('stripHtml drops tags, comments, scripts and styles and decodes entities', () => {
    assert.equal(stripHtml(html), 'Intro After blank line, *indented*');
    assert.equal(
      stripHtml('<head><title>T</title><style>p{color:red}</style></head><!-- c --><p>A &amp; B&nbsp;&#8211; <b>bo</b>ld</p><script>alert(1)</script><br>end'),
      'A & B – bold end'
    );
    assert.equal(stripHtml('text <a href="x"'), 'text', 'a tag cut off at the end of a snippet');
    assert.equal(stripHtml(''), '');
  });

  test('notePreview picks the stripper by markup language', () => {
    assert.equal(notePreview('<p>*a*</p>', 2), '*a*');
    assert.equal(notePreview('<p>*a*</p>', 1), 'a');
  });
});
