import { describe, expect, it } from "vitest";
import { dueTime, formatDueDate, fromDateTimeLocal, isOverdue, toDateTimeLocal } from "./due";

const NOW = new Date(2026, 5, 15, 12, 0).getTime();

describe("due dates", () => {
  it("only to-dos with a positive todoDue have a due date", () => {
    expect(dueTime({ isTodo: true, todoDue: 5000 })).toBe(5000);
    expect(dueTime({ isTodo: true, todoDue: 0 })).toBe(0);
    expect(dueTime({ isTodo: true })).toBe(0);
    expect(dueTime({ isTodo: false, todoDue: 5000 })).toBe(0);
  });

  it("is overdue only while open and past due", () => {
    expect(isOverdue({ isTodo: true, todoDue: NOW - 1 }, NOW)).toBe(true);
    expect(isOverdue({ isTodo: true, todoDue: NOW + 60_000 }, NOW)).toBe(false);
    expect(isOverdue({ isTodo: true, todoDue: NOW - 1, todoCompleted: true }, NOW)).toBe(false);
    expect(isOverdue({ isTodo: true, todoDue: 0 }, NOW)).toBe(false);
  });

  it("round-trips local datetime-local values", () => {
    const ms = new Date(2026, 10, 3, 9, 30).getTime();
    expect(toDateTimeLocal(ms)).toBe("2026-11-03T09:30");
    expect(fromDateTimeLocal("2026-11-03T09:30")).toBe(ms);
    expect(fromDateTimeLocal("2026-11-03T09:30:00")).toBe(ms);
  });

  it("rejects empty or invalid values", () => {
    expect(fromDateTimeLocal("")).toBeNull();
    expect(fromDateTimeLocal("2026-11-03")).toBeNull();
    expect(fromDateTimeLocal("2026-02-31T10:00")).toBeNull();
    expect(fromDateTimeLocal("tomorrow")).toBeNull();
  });

  it("shows the year only when it differs", () => {
    expect(formatDueDate(new Date(2026, 10, 3, 9, 30).getTime(), NOW)).not.toMatch(/2026/);
    expect(formatDueDate(new Date(2027, 0, 3, 9, 30).getTime(), NOW)).toMatch(/2027/);
  });
});
