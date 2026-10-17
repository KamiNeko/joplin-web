import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { deserialize, serialize } from '../src/services/serializer.js';
import { JoplinItemType } from '../src/types/index.js';

/**
 * Round-trip fidelity of Joplin's text format: carriage returns (#47), property order (#54) and
 * property escaping (#55). Joplin's BaseItem.unserialize splits on "\n" only, so a "\r" in a
 * note body is part of the text.
 */

const props = {
  id: 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6',
  parent_id: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
  created_time: '2026-10-17T16:00:00.000Z',
  updated_time: '2026-10-17T16:05:00.000Z',
  is_todo: '0',
  deleted_time: '0',
  type_: '1',
};

const propLines = Object.entries(props)
  .map(([key, value]) => `${key}: ${value}`)
  .join('\n');

/** Re-serializes a parsed note the way the writer does for a metadata-only change */
function rewrite(raw: string, changes: Record<string, string> = {}): string {
  const item = deserialize(raw);
  return serialize({
    type_: item.type_,
    title: item.title,
    body: item.body,
    properties: { ...item.properties, ...changes },
  });
}

/** The title + body section of a serialized item (everything above the property block) */
function textSection(raw: string): string {
  return raw.slice(0, raw.lastIndexOf('\n\nid: '));
}

describe('serializer: round-trip fidelity', () => {
  test('keeps CRLF line endings inside a note body', () => {
    const raw = `Title\n\nline1\r\nline2\r\n\nlast\n\n${propLines}`;
    const item = deserialize(raw);
    assert.equal(item.title, 'Title');
    assert.equal(item.body, 'line1\r\nline2\r\n\nlast');
    assert.equal(rewrite(raw), raw);
  });

  test('keeps a trailing CR at the end of the body', () => {
    const raw = `Title\n\nline1\r\nline2\r\n\n${propLines}`;
    assert.equal(deserialize(raw).body, 'line1\r\nline2\r');
    assert.equal(rewrite(raw), raw);
  });

  test('keeps a lone CR inside a line', () => {
    const raw = `Title\n\nbefore\rafter\nnext\n\n${propLines}`;
    assert.equal(deserialize(raw).body, 'before\rafter\nnext');
    assert.equal(rewrite(raw), raw);
  });

  test('keeps a body that ends with a CRLF line break', () => {
    const body = 'a\r\nb\r\n';
    const out = serialize({ type_: JoplinItemType.Note, title: 'T', body, properties: props });
    assert.equal(deserialize(out).body, body);
  });

  test('a metadata-only write (move, trash) leaves title and body byte-identical', () => {
    const raw = `Windows note\n\n# Heading\r\n\r\n- item 1\r\n- item 2\r\n\n${propLines}`;
    const moved = rewrite(raw, {
      parent_id: 'c1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6',
      deleted_time: '1760716800000',
      updated_time: '2026-10-18T10:00:00.000Z',
    });
    assert.equal(textSection(moved), textSection(raw));
    const parsed = deserialize(moved);
    assert.equal(parsed.parentId, 'c1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6');
    assert.equal(parsed.deletedTime, 1760716800000);
  });

  test('still parses properties written with CRLF line endings', () => {
    const raw = `Title\r\n\r\nbody\r\n\r\n${propLines.replace(/\n/g, '\r\n')}`;
    const item = deserialize(raw);
    assert.equal(item.id, props.id);
    assert.equal(item.parentId, props.parent_id);
    assert.equal(item.type_, JoplinItemType.Note);
    assert.equal(item.properties.deleted_time, '0');
  });

  test('treats a lone CR as the title/body separator, like Joplin', () => {
    const item = deserialize(`Title\n\r\nbody\n\n${propLines}`);
    assert.equal(item.body, 'body');
  });

  test('keeps a stray CR in a title instead of turning it into a space', () => {
    const out = serialize({ type_: JoplinItemType.Note, title: 'A\rB', body: 'x', properties: props });
    assert.equal(deserialize(out).title, 'A\rB');
  });

  test('still replaces line feeds in a title, which would corrupt the format', () => {
    const out = serialize({ type_: JoplinItemType.Note, title: 'A\r\nB\nC', body: 'x', properties: props });
    const item = deserialize(out);
    assert.equal(item.title, 'A B C');
    assert.equal(item.body, 'x');
  });

  test('keeps the property order of the raw item (#54)', () => {
    const raw = `Title\n\nbody\n\n${propLines}`;
    const out = rewrite(raw);
    assert.equal(out, raw);
    const lines = out.split('\n');
    assert.ok(lines[4].startsWith('id: '), 'id stays first');
    assert.equal(lines[lines.length - 1], 'type_: 1', 'type_ stays last');
    assert.equal(rewrite(out), raw, 'stable over repeated writes');
  });

  test('keeps the order for every item type (#54)', () => {
    const folder = 'Folder\n\nid: c1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6\ncreated_time: 2026-10-17T16:00:00.000Z\nparent_id: \ndeleted_time: 0\ntype_: 2';
    const tag = 'tag\n\nid: d1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6\nuser_data: \nis_shared: 0\ntype_: 5';
    const link =
      'id: e1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6\nnote_id: b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6\ntag_id: d1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6\ntype_: 6';
    for (const raw of [folder, tag]) assert.equal(rewrite(raw), raw);
    const parsedLink = deserialize(link);
    assert.equal(serialize({ type_: parsedLink.type_, body: '', properties: parsedLink.properties }), link);
  });

  test('a duplicated property keeps the topmost value, like Joplin', () => {
    const item = deserialize(`T\n\nid: ${props.id}\nfoo: top\nfoo: bottom\ntype_: 1`);
    assert.equal(item.properties.foo, 'top');
  });

  test('escapes property values exactly like Joplin BaseItem (#55)', () => {
    // Joplin's serialize_format / unserialize_format chains, copied for comparison
    const joplinEscape = (v: string) =>
      v.replace(/\\n/g, '\\\\n').replace(/\\r/g, '\\\\r').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
    const joplinUnescape = (v: string) =>
      v.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\\n/g, '\\n').replace(/\\\r/g, '\\r');
    const values = ['plain', 'two\nlines', 'cr\rhere', 'literal \\n stays', 'a\\\nb', '{"x":"y\\nz"}'];
    for (const value of values) {
      const out = serialize({ type_: JoplinItemType.Note, title: 'T', body: '', properties: { ...props, user_data: value } });
      const line = out.split('\n').find((l) => l.startsWith('user_data: '))!;
      assert.equal(line, `user_data: ${joplinEscape(value)}`, `escape ${JSON.stringify(value)}`);
      assert.equal(deserialize(out).properties.user_data, joplinUnescape(joplinEscape(value)), `unescape ${JSON.stringify(value)}`);
    }
  });

  test('round-trips an empty body and an empty title', () => {
    const out = serialize({ type_: JoplinItemType.Note, title: '', body: '', properties: props });
    const item = deserialize(out);
    assert.equal(item.title, '');
    assert.equal(item.body, '');
    assert.equal(item.id, props.id);
  });
});
