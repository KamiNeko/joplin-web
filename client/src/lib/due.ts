/**
 * Helpers for to-do due dates. Joplin stores `todo_due` as Unix milliseconds, 0 when unset.
 */

interface DueInfo {
  isTodo?: boolean;
  todoCompleted?: boolean;
  todoDue?: number;
}

/** Returns the due date of a to-do in Unix ms, or 0 when it has none (or is not a to-do). */
export function dueTime(note: DueInfo): number {
  return note.isTodo && note.todoDue && note.todoDue > 0 ? note.todoDue : 0;
}

/** True for an open to-do whose due date has passed. */
export function isOverdue(note: DueInfo, now = Date.now()): boolean {
  const due = dueTime(note);
  return due > 0 && !note.todoCompleted && due < now;
}

/** Formats a due date as a short local date and time, with the year only when it differs from now. */
export function formatDueDate(ms: number, now = Date.now()): string {
  const date = new Date(ms);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== new Date(now).getFullYear() ? "numeric" : undefined,
    hour: "numeric",
    minute: "2-digit",
  });
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Converts Unix ms into the local `YYYY-MM-DDTHH:mm` value of an `<input type="datetime-local">`. */
export function toDateTimeLocal(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Parses the value of an `<input type="datetime-local">` (local time, seconds optional) into Unix ms.
 * Returns null for an empty or invalid value.
 */
export function fromDateTimeLocal(value: string): number | null {
  const m = /^(\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(value.trim());
  if (!m) return null;
  const [year, month, day, hour, minute, second = "0"] = m.slice(1).map((v) => v ?? "0");
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  // Reject overflowing values such as February 31st
  if (date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day)) return null;
  const ms = date.getTime();
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}
