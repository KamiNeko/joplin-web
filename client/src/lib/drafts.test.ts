import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAllDrafts,
  clearDraft,
  DRAFT_MAX_AGE_MS,
  draftOwner,
  findRestorableDraft,
  loadDraft,
  restoreStoredDraft,
  saveDraft,
  setDraftOwner,
} from "./drafts";

const NOTE_A = "a".repeat(32);
const NOTE_B = "b".repeat(32);
const ME = draftOwner("Me@Example.com", "notes.example.com");
const NOW = 1_700_000_000_000;

describe("draft storage", () => {
  beforeEach(() => {
    localStorage.clear();
    setDraftOwner(ME, NOW);
  });

  it("round-trips a draft with its base time and owner", () => {
    saveDraft(NOTE_A, { title: "T", body: "B", baseUpdatedTime: 42 }, NOW);
    expect(loadDraft(NOTE_A, NOW)).toEqual({ title: "T", body: "B", baseUpdatedTime: 42, savedAt: NOW, owner: ME });
    expect(loadDraft(NOTE_B, NOW)).toBeNull();
  });

  it("normalises the owner's email", () => {
    expect(draftOwner(" me@example.com ", "notes.example.com")).toBe(ME);
    expect(draftOwner("me@example.com", "other.example.com")).not.toBe(ME);
  });

  it("ignores malformed entries", () => {
    localStorage.setItem(`joplin-draft:${NOTE_A}`, "{not json");
    expect(loadDraft(NOTE_A, NOW)).toBeNull();
    localStorage.setItem(`joplin-draft:${NOTE_A}`, JSON.stringify({ title: "T" }));
    expect(loadDraft(NOTE_A, NOW)).toBeNull();
  });

  it("writes nothing without an owner (signed out)", () => {
    setDraftOwner(null, NOW);
    saveDraft(NOTE_A, { title: "", body: "x", baseUpdatedTime: 1 }, NOW);
    expect(localStorage.length).toBe(0);
  });

  it("never offers another owner's draft and drops it when someone else signs in", () => {
    saveDraft(NOTE_A, { title: "", body: "mine", baseUpdatedTime: 1 }, NOW);
    const other = draftOwner("someone@example.com", "notes.example.com");
    setDraftOwner(other, NOW);
    expect(loadDraft(NOTE_A, NOW)).toBeNull();
    // Gone for good, also for the original owner
    setDraftOwner(ME, NOW);
    expect(loadDraft(NOTE_A, NOW)).toBeNull();
  });

  it("keeps the same owner's drafts across sign-ins", () => {
    saveDraft(NOTE_A, { title: "", body: "mine", baseUpdatedTime: 1 }, NOW);
    setDraftOwner(draftOwner("me@example.com", "notes.example.com"), NOW + 1000);
    expect(loadDraft(NOTE_A, NOW + 1000)?.body).toBe("mine");
  });

  it("expires drafts after the maximum age", () => {
    saveDraft(NOTE_A, { title: "", body: "old", baseUpdatedTime: 1 }, NOW);
    expect(loadDraft(NOTE_A, NOW + DRAFT_MAX_AGE_MS)).not.toBeNull();
    expect(loadDraft(NOTE_A, NOW + DRAFT_MAX_AGE_MS + 1)).toBeNull();
    expect(localStorage.getItem(`joplin-draft:${NOTE_A}`)).toBeNull();

    saveDraft(NOTE_B, { title: "", body: "old", baseUpdatedTime: 1 }, NOW);
    setDraftOwner(ME, NOW + DRAFT_MAX_AGE_MS + 1);
    expect(localStorage.getItem(`joplin-draft:${NOTE_B}`)).toBeNull();
  });

  it("clears one draft or all drafts, leaving other keys alone", () => {
    localStorage.setItem("joplin-theme", "dark");
    saveDraft(NOTE_A, { title: "", body: "a", baseUpdatedTime: 1 }, NOW);
    saveDraft(NOTE_B, { title: "", body: "b", baseUpdatedTime: 1 }, NOW);
    clearDraft(NOTE_A);
    expect(loadDraft(NOTE_A, NOW)).toBeNull();
    expect(loadDraft(NOTE_B, NOW)).not.toBeNull();
    clearAllDrafts();
    expect(loadDraft(NOTE_B, NOW)).toBeNull();
    expect(localStorage.getItem("joplin-theme")).toBe("dark");
  });

  it("puts a discarded draft back unchanged (undo)", () => {
    saveDraft(NOTE_A, { title: "T", body: "B", baseUpdatedTime: 7 }, NOW);
    const draft = loadDraft(NOTE_A, NOW)!;
    clearDraft(NOTE_A);
    restoreStoredDraft(NOTE_A, draft);
    expect(loadDraft(NOTE_A, NOW)).toEqual(draft);
  });

  it("offers only drafts that differ from the server text", () => {
    saveDraft(NOTE_A, { title: "T", body: "mine", baseUpdatedTime: 1 }, NOW);
    expect(findRestorableDraft({ id: NOTE_A, title: "T", body: "theirs" }, NOW)?.body).toBe("mine");
    expect(findRestorableDraft({ id: NOTE_A, title: "T", body: "mine" }, NOW)).toBeNull();
    // The stale draft is removed
    expect(loadDraft(NOTE_A, NOW)).toBeNull();
  });

  it("survives unavailable storage", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => saveDraft(NOTE_A, { title: "", body: "x", baseUpdatedTime: 1 }, NOW)).not.toThrow();
    expect(loadDraft(NOTE_A, NOW)).toBeNull();
  });
});
