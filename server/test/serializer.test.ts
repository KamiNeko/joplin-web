import { deserialize, serialize } from '../src/services/serializer.js';
import { JoplinItemType } from '../src/types/index.js';

/**
 * Offline tests for the Joplin sync-format serializer (no server required).
 */
let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`✓ ${name}`);
  } else {
    failures++;
    console.error(`✗ ${name}`, detail ?? '');
  }
}

const baseProps = {
  id: 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6',
  parent_id: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
  created_time: '2026-10-17T16:00:00.000Z',
  updated_time: '2026-10-17T16:05:00.000Z',
  is_todo: '0',
  deleted_time: '0',
};

// Multi-line body with blank lines round-trips unchanged
{
  const body = '# Heading\n\nParagraph one.\n\n\n- item\n\n```js\nconst x = 1;\n```\n';
  const out = deserialize(serialize({ type_: JoplinItemType.Note, title: 'Title', body, properties: baseProps }));
  check('multi-line body round-trips', out.body === body && out.title === 'Title', out);
}

// Empty title must not swallow the first body line
{
  const out = deserialize(serialize({ type_: JoplinItemType.Note, title: '', body: 'First line\nSecond', properties: baseProps }));
  check('empty title keeps body intact', out.title === '' && out.body === 'First line\nSecond', out);
}

// Empty body
{
  const out = deserialize(serialize({ type_: JoplinItemType.Note, title: 'Only title', body: '', properties: baseProps }));
  check('empty body round-trips', out.title === 'Only title' && out.body === '', out);
}

// Titles are forced onto a single line
{
  const out = deserialize(serialize({ type_: JoplinItemType.Note, title: 'Line 1\nLine 2', body: 'x', properties: baseProps }));
  check('multi-line title is flattened', out.title === 'Line 1 Line 2' && out.body === 'x', out);
}

// Properties survive, including unknown ones and escaped newlines
{
  const props = { ...baseProps, custom_field: 'keep me', user_data: 'a\nb' };
  const out = deserialize(serialize({ type_: JoplinItemType.Note, title: 'T', body: 'B', properties: props }));
  check(
    'properties round-trip (unknown + escaped newline)',
    out.properties.custom_field === 'keep me' && out.properties.user_data === 'a\nb' && out.parentId === baseProps.parent_id,
    out.properties
  );
}

// Folders have a title but no body
{
  const out = deserialize(
    serialize({ type_: JoplinItemType.Folder, title: 'Notebook', body: 'ignored', properties: { id: baseProps.id, parent_id: '' } })
  );
  check('folder round-trips without body', out.type_ === JoplinItemType.Folder && out.title === 'Notebook' && out.body === '', out);
}

// Note-tag links have no title line, only properties
{
  const props = { id: baseProps.id, note_id: 'a'.repeat(32), tag_id: 'b'.repeat(32) };
  const serialized = serialize({ type_: JoplinItemType.NoteTag, body: '', properties: props });
  const out = deserialize(serialized);
  check(
    'note-tag link round-trips without a title line',
    !serialized.startsWith('\n') &&
      serialized.split('\n')[0] === `id: ${baseProps.id}` &&
      out.type_ === JoplinItemType.NoteTag &&
      out.properties.note_id === props.note_id &&
      out.properties.tag_id === props.tag_id,
    serialized
  );
}

// deleted_time is kept as epoch milliseconds
{
  const out = deserialize(
    serialize({ type_: JoplinItemType.Note, title: 'T', body: '', properties: { ...baseProps, deleted_time: '1792256400000' } })
  );
  check('deleted_time is parsed', out.deletedTime === 1792256400000, out.deletedTime);
}

if (failures > 0) {
  console.error(`\n${failures} serializer test(s) failed`);
  process.exit(1);
}
console.log('\nAll serializer tests passed');
