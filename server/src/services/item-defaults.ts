/**
 * Property sets for new Joplin items, matching what Joplin desktop writes. Used by the note writer
 * when it creates notes, notebooks, tags, note-tag links and resources.
 */

/** Default property set Joplin desktop writes for a new note */
export function defaultNoteProperties(id: string, parentId: string, isTodo: boolean): Record<string, string> {
  const now = new Date().toISOString();
  return {
    id,
    parent_id: parentId,
    created_time: now,
    updated_time: now,
    is_conflict: '0',
    latitude: '0.00000000',
    longitude: '0.00000000',
    altitude: '0.0000',
    author: '',
    source_url: '',
    is_todo: isTodo ? '1' : '0',
    todo_due: '0',
    todo_completed: '0',
    source: 'joplin-web',
    source_application: 'net.cozic.joplin-web',
    application_data: '',
    order: '0',
    user_created_time: now,
    user_updated_time: now,
    encryption_cipher_text: '',
    encryption_applied: '0',
    markup_language: '1',
    is_shared: '0',
    share_id: '',
    conflict_original_id: '',
    master_key_id: '',
    user_data: '',
    deleted_time: '0',
  };
}

/** Default property set Joplin desktop writes for a new notebook */
export function defaultFolderProperties(id: string, parentId: string): Record<string, string> {
  const now = new Date().toISOString();
  return {
    id,
    created_time: now,
    updated_time: now,
    user_created_time: now,
    user_updated_time: now,
    encryption_cipher_text: '',
    encryption_applied: '0',
    parent_id: parentId,
    is_shared: '0',
    share_id: '',
    master_key_id: '',
    icon: '',
    user_data: '',
    deleted_time: '0',
  };
}

/** Default property set Joplin desktop writes for a new resource (attachment) */
export function defaultResourceProperties(
  id: string,
  file: { mime: string; extension: string; size: number }
): Record<string, string> {
  const now = new Date();
  const iso = now.toISOString();
  return {
    id,
    mime: file.mime,
    filename: '',
    created_time: iso,
    updated_time: iso,
    user_created_time: iso,
    user_updated_time: iso,
    file_extension: file.extension,
    encryption_cipher_text: '',
    encryption_applied: '0',
    encryption_blob_encrypted: '0',
    size: String(file.size),
    is_shared: '0',
    share_id: '',
    master_key_id: '',
    user_data: '',
    blob_updated_time: String(now.getTime()),
    ocr_text: '',
    ocr_details: '',
    ocr_status: '0',
    ocr_error: '',
  };
}

/** Default property set Joplin desktop writes for a new tag */
export function defaultTagProperties(id: string): Record<string, string> {
  const now = new Date().toISOString();
  return {
    id,
    created_time: now,
    updated_time: now,
    user_created_time: now,
    user_updated_time: now,
    encryption_cipher_text: '',
    encryption_applied: '0',
    is_shared: '0',
    parent_id: '',
    user_data: '',
  };
}

/** Default property set Joplin desktop writes for a note-tag link */
export function defaultNoteTagProperties(id: string, noteId: string, tagId: string): Record<string, string> {
  const now = new Date().toISOString();
  return {
    id,
    note_id: noteId,
    tag_id: tagId,
    created_time: now,
    updated_time: now,
    user_created_time: now,
    user_updated_time: now,
    encryption_cipher_text: '',
    encryption_applied: '0',
    is_shared: '0',
  };
}
