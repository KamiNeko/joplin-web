import { describe, expect, it } from "vitest";
import {
  computeNoteStats,
  extractHeadings,
  joplinToRichMarkdown,
  richMarkdownToJoplin,
} from "./note-stats";

describe("extractHeadings", () => {
  it("extracts headings outside fenced code blocks with clean text and unique slugs", () => {
    const md = [
      "# Project Roadmap",
      "",
      "```markdown",
      "# Inside Backtick Fence",
      "## Ignored Subheading",
      "```",
      "",
      "~~~",
      "# Inside Tilde Fence",
      "~~~",
      "",
      "## Phase **1** `Alpha` [Docs](https://example.com) ##",
      "### Overview",
      "### Overview",
      "### Overview",
    ].join("\n");

    expect(extractHeadings(md)).toEqual([
      { level: 1, text: "Project Roadmap", slug: "project-roadmap" },
      { level: 2, text: "Phase 1 Alpha Docs", slug: "phase-1-alpha-docs" },
      { level: 3, text: "Overview", slug: "overview" },
      { level: 3, text: "Overview", slug: "overview-1" },
      { level: 3, text: "Overview", slug: "overview-2" },
    ]);
  });

  it("returns empty array for empty markdown", () => {
    expect(extractHeadings("")).toEqual([]);
  });
});

describe("computeNoteStats", () => {
  it("computes words, chars, and reading time for markdown and HTML", () => {
    const md = "# Title\n\nHello **world**! `ignore code`\n\n[Click here](https://example.com)";
    const mdStats = computeNoteStats(md, false);
    expect(mdStats.words).toBeGreaterThanOrEqual(4);
    expect(mdStats.characters).toBeGreaterThan(0);
    expect(mdStats.readingMinutes).toBe(1);

    const htmlStats = computeNoteStats("<p>One two&nbsp;three four</p>", true);
    expect(htmlStats).toEqual({ words: 4, characters: 15, readingMinutes: 1 });

    expect(computeNoteStats("", false)).toEqual({ words: 0, characters: 0, readingMinutes: 0 });
  });
});

describe("joplinToRichMarkdown and richMarkdownToJoplin", () => {
  const imgId = "0123456789abcdef0123456789abcdef";
  const noteId = "fedcba9876543210fedcba9876543210";

  it("round-trips resource images and note links", () => {
    const original = `Look:\n![cover photo](:/${imgId})\n\nSee [Roadmap](:/${noteId}#phase-1)`;
    const rich = joplinToRichMarkdown(original);
    expect(rich).toBe(
      `Look:\n![cover photo](/api/resources/${imgId})\n\nSee [Roadmap](/joplin-item/${noteId}#phase-1)`
    );

    expect(richMarkdownToJoplin(rich)).toBe(original);
  });

  it("normalizes absolute URLs emitted by TipTap serializers back to :/id", () => {
    const serialized = `![pic](http://localhost:5173/api/resources/${imgId}) and [Note](https://notes.example.com/joplin-item/${noteId})`;
    expect(richMarkdownToJoplin(serialized)).toBe(
      `![pic](:/${imgId}) and [Note](:/${noteId})`
    );
  });
});
