/**
 * How long before a notebook's deleted_time an item may have been trashed and still count as
 * trashed together with it. Joplin Web stamps a whole cascade with one time, but Joplin desktop
 * trashes the notes and sub-notebooks first, each with its own Date.now(), and the notebook last.
 */
export const TRASH_CASCADE_WINDOW_MS = 60 * 1000;

/**
 * Whether an item was trashed together with a notebook trashed at `notebookDeletedTime`
 * (rather than individually before it). Items that are not trashed never match.
 */
export function trashedTogether(item: { deletedTime: number }, notebookDeletedTime: number): boolean {
  return item.deletedTime > 0 && item.deletedTime >= notebookDeletedTime - TRASH_CASCADE_WINDOW_MS;
}
