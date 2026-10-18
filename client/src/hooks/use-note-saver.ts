import { useRef } from "react";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import { NoteUpdate, updateNote } from "@/lib/api";
import { Note } from "@/lib/types";
import { invalidateLists } from "./use-mutations";

export interface NoteSaveHandlers {
  /** What to put into the ["note", id] query instead of the saved note (e.g. to keep a newer optimistic body) */
  toCache?: (saved: Note) => Note;
  /** Runs after the cache update, while the save still counts as in flight */
  onSaved?: (saved: Note) => void;
  /** Runs on any failure (409 conflict included, see getConflictNote), while the save still counts as in flight */
  onError?: (err: unknown) => void;
}

/**
 * Writes one note with conflict detection. Callers run one save at a time: they check `inflight`
 * and wait for (or reschedule after) it, so each save starts from the base the previous one returned.
 */
export interface NoteSaver {
  readonly noteId: string;
  /** updatedTime of the version the next save is based on (sent as baseUpdatedTime; null sends none) */
  baseUpdatedTime: number | null;
  /** The save currently talking to the server, until its handlers have run */
  readonly inflight: Promise<boolean> | null;
  /**
   * Sends `changes` based on `baseUpdatedTime`. On success adopts the returned updatedTime as the new
   * base, stores the note in the query cache and refreshes the lists. Resolves whether it was saved.
   */
  send(changes: Omit<NoteUpdate, "baseUpdatedTime">, handlers?: NoteSaveHandlers): Promise<boolean>;
}

/**
 * Creates the save state for one note (see NoteSaver).
 */
export function createNoteSaver(
  queryClient: QueryClient,
  noteId: string,
  baseUpdatedTime: number | null = null
): NoteSaver {
  let inflight: Promise<boolean> | null = null;
  const saver: NoteSaver = {
    noteId,
    baseUpdatedTime,
    get inflight() {
      return inflight;
    },
    send(changes, { toCache, onSaved, onError } = {}) {
      const run = (async () => {
        try {
          const saved = await updateNote(noteId, { ...changes, baseUpdatedTime: saver.baseUpdatedTime ?? undefined });
          saver.baseUpdatedTime = saved.updatedTime;
          queryClient.setQueryData(["note", noteId], toCache ? toCache(saved) : saved);
          invalidateLists(queryClient);
          onSaved?.(saved);
          return true;
        } catch (err) {
          onError?.(err);
          return false;
        } finally {
          inflight = null;
        }
      })();
      inflight = run;
      return run;
    },
  };
  return saver;
}

/**
 * The NoteSaver for `noteId`, kept across renders (null while no note is loaded). `baseUpdatedTime`
 * is the initial base when the saver is created.
 */
export function useNoteSaver(noteId: string | undefined, baseUpdatedTime: number | null = null): NoteSaver | null {
  const queryClient = useQueryClient();
  const saverRef = useRef<NoteSaver | null>(null);
  if (noteId && saverRef.current?.noteId !== noteId) {
    saverRef.current = createNoteSaver(queryClient, noteId, baseUpdatedTime);
  }
  return noteId ? saverRef.current : null;
}
