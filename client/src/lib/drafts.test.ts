import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearAllDrafts, clearDraft, findRestorableDraft, loadDraft, saveDraft } from "./drafts";

const NOTE_A = "a".repeat(32);
const NOTE_B = "b".repeat(32);

describe("draft storage", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips a draft with its base time", () => {
    saveDraft(NOTE_A, { title: "T", body: "B", baseUpdatedTime: 42 }, 1000);
    expect(loadDraft(NOTE_A)).toEqual({ title: "T", body: "B", baseUpdatedTime: 42, savedAt: 1000 });
    expect(loadDraft(NOTE_B)).toBeNull();
  });

  it("ignores malformed entries", () => {
    localStorage.setItem(`joplin-draft:${NOTE_A}`, "{not json");
    expect(loadDraft(NOTE_A)).toBeNull();
    localStorage.setItem(`joplin-draft:${NOTE_A}`, JSON.stringify({ title: "T" }));
    expect(loadDraft(NOTE_A)).toBeNull();
  });

  it("clears one draft or all drafts, leaving other keys alone", () => {
    localStorage.setItem("joplin-theme", "dark");
    saveDraft(NOTE_A, { title: "", body: "a", baseUpdatedTime: 1 });
    saveDraft(NOTE_B, { title: "", body: "b", baseUpdatedTime: 1 });
    clearDraft(NOTE_A);
    expect(loadDraft(NOTE_A)).toBeNull();
    expect(loadDraft(NOTE_B)).not.toBeNull();
    clearAllDrafts();
    expect(loadDraft(NOTE_B)).toBeNull();
    expect(localStorage.getItem("joplin-theme")).toBe("dark");
  });

  it("offers only drafts that differ from the server text", () => {
    saveDraft(NOTE_A, { title: "T", body: "mine", baseUpdatedTime: 1 });
    expect(findRestorableDraft({ id: NOTE_A, title: "T", body: "theirs" })?.body).toBe("mine");
    expect(findRestorableDraft({ id: NOTE_A, title: "T", body: "mine" })).toBeNull();
    // The stale draft is removed
    expect(loadDraft(NOTE_A)).toBeNull();
  });

  it("survives unavailable storage", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => saveDraft(NOTE_A, { title: "", body: "x", baseUpdatedTime: 1 })).not.toThrow();
    expect(loadDraft(NOTE_A)).toBeNull();
  });
});
