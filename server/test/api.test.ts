import { deserialize, serialize, stripMarkdown } from '../src/services/serializer.js';
import { JoplinItemType } from '../src/types/index.js';
import { joplinApi } from '../src/services/joplin-api.js';
import { noteCache } from '../src/services/note-cache.js';
import '../src/index.js';

async function runAllTests() {
  console.log('=== Joplin Web Backend Test Suite ===\n');

  console.log('--- 1. Testing Serializer & Deserializer ---');

  // Test note serialization and deserialization
  const sampleNoteContent = `My Test Note

Here is line 1.
Here is line 2 with **bold** text.

id: b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6
parent_id: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6
created_time: 2026-10-17T16:00:00.000Z
updated_time: 2026-10-17T16:05:00.000Z
is_todo: 0
type_: 1`;

  const parsedNote = deserialize(sampleNoteContent, 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6.md');
  if (parsedNote.title !== 'My Test Note') throw new Error('Note title mismatch');
  if (!parsedNote.body.includes('Here is line 1.')) throw new Error('Note body mismatch');
  if (parsedNote.id !== 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6') throw new Error('Note id mismatch');
  console.log('✓ Note parsing passed');

  // Test folder with empty id fallback to filename
  const sampleFolderContent = `Test Notebook

id: 
created_time: 2026-10-17T16:00:00.000Z
updated_time: 2026-10-17T16:00:00.000Z
parent_id: 
type_: 2`;

  const parsedFolder = deserialize(sampleFolderContent, 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6.md');
  if (parsedFolder.title !== 'Test Notebook') throw new Error('Folder title mismatch');
  if (parsedFolder.id !== 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6') throw new Error('Folder fallback id mismatch');
  console.log('✓ Folder parsing passed');

  // Test NoteTag parsing
  const sampleNoteTag = `id: notetag123
note_id: b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6
tag_id: tag123
type_: 6`;

  const parsedNoteTag = deserialize(sampleNoteTag);
  if (parsedNoteTag.type_ !== JoplinItemType.NoteTag) throw new Error('NoteTag type mismatch');
  console.log('✓ NoteTag link parsing passed');

  // Test roundtrip serialization
  const serialized = serialize({
    type_: JoplinItemType.Note,
    id: 'note_test_1',
    title: 'Serialized Title',
    body: 'Serialized Body',
    parentId: 'folder_1',
    createdTime: 1729180800000,
    updatedTime: 1729180900000,
  });
  const roundtrip = deserialize(serialized);
  if (roundtrip.title !== 'Serialized Title' || roundtrip.body !== 'Serialized Body') {
    throw new Error('Roundtrip serialization failed');
  }
  console.log('✓ Roundtrip serialization passed');

  // Test Markdown preview stripping
  const preview = stripMarkdown('## Title\nThis is **bold** and *italic* with [link](http://example.com) and `code`!');
  if (preview !== 'Title This is bold and italic with link and code!') {
    throw new Error(`stripMarkdown failed: got "${preview}"`);
  }
  console.log('✓ Markdown preview stripping passed');

  // Joplin Server connectivity test
  console.log('\n--- 2. Testing Joplin API Service ---');
  const pingRes = await joplinApi.ping();
  if (pingRes.status !== 'ok') throw new Error('Joplin server ping failed');
  console.log('✓ Joplin Server ping passed');

  // Wait 1.5s for Express HTTP server to start
  await new Promise((r) => setTimeout(r, 1500));
  const baseUrl = 'http://127.0.0.1:3001';
  const session = 'Gfc7y2EOJ8OQcxIB4ZswqF';

  console.log('\n--- 3. Testing Express HTTP Endpoints ---');

  // Health
  const healthRes = await fetch(`${baseUrl}/api/health`);
  if (healthRes.status !== 200) throw new Error(`Health status expected 200, got ${healthRes.status}`);
  console.log('✓ GET /api/health passed');

  // Auth check unauthenticated
  const unauthRes = await fetch(`${baseUrl}/api/auth/check`);
  if (unauthRes.status !== 401) throw new Error(`Unauth status expected 401, got ${unauthRes.status}`);
  console.log('✓ GET /api/auth/check (unauthenticated 401) passed');

  // Auth check authenticated
  const authRes = await fetch(`${baseUrl}/api/auth/check`, {
    headers: { Authorization: `Bearer ${session}` },
  });
  if (authRes.status !== 200) throw new Error(`Auth status expected 200, got ${authRes.status}`);
  console.log('✓ GET /api/auth/check (authenticated 200) passed');

  // Notebooks tree
  const notebooksRes = await fetch(`${baseUrl}/api/notebooks`, {
    headers: { Authorization: `Bearer ${session}` },
  });
  if (notebooksRes.status !== 200) throw new Error(`Notebooks status expected 200, got ${notebooksRes.status}`);
  const notebooks = await notebooksRes.json();
  if (!Array.isArray(notebooks) || notebooks.length === 0) throw new Error('Expected notebooks array');
  console.log(`✓ GET /api/notebooks passed (${notebooks.length} notebooks found)`);

  // Notes list
  const notesRes = await fetch(`${baseUrl}/api/notes`, {
    headers: { Authorization: `Bearer ${session}` },
  });
  if (notesRes.status !== 200) throw new Error(`Notes status expected 200, got ${notesRes.status}`);
  const notes = await notesRes.json();
  if (!Array.isArray(notes) || notes.length === 0) throw new Error('Expected notes array');
  console.log(`✓ GET /api/notes passed (${notes.length} notes found)`);

  // Note detail
  const noteRes = await fetch(`${baseUrl}/api/notes/${notes[0].id}`, {
    headers: { Authorization: `Bearer ${session}` },
  });
  if (noteRes.status !== 200) throw new Error(`Note detail status expected 200, got ${noteRes.status}`);
  const noteDetail = await noteRes.json();
  if (!noteDetail.title || !noteDetail.body) throw new Error('Expected title and body in note detail');
  console.log('✓ GET /api/notes/:id passed');

  // Tags list
  const tagsRes = await fetch(`${baseUrl}/api/tags`, {
    headers: { Authorization: `Bearer ${session}` },
  });
  if (tagsRes.status !== 200) throw new Error(`Tags status expected 200, got ${tagsRes.status}`);
  console.log('✓ GET /api/tags passed');

  // Search
  const searchRes = await fetch(`${baseUrl}/api/search?q=test`, {
    headers: { Authorization: `Bearer ${session}` },
  });
  if (searchRes.status !== 200) throw new Error(`Search status expected 200, got ${searchRes.status}`);
  const searchResults = await searchRes.json();
  if (!Array.isArray(searchResults)) throw new Error('Expected search results array');
  console.log(`✓ GET /api/search passed (${searchResults.length} matches found)`);

  // Logout
  const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session}` },
  });
  if (logoutRes.status !== 200) throw new Error(`Logout status expected 200, got ${logoutRes.status}`);
  console.log('✓ POST /api/auth/logout passed');

  console.log('\n===========================================');
  console.log(' ALL SUITE TESTS COMPLETED AND VERIFIED! ');
  console.log('===========================================\n');
  process.exit(0);
}

runAllTests().catch((err) => {
  console.error('\n❌ Test suite failed:', err);
  process.exit(1);
});
