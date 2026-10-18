import { describe, expect, it } from "vitest";
import { findHeading, fragmentSlug, headingSlug } from "./heading-slug";

describe("headingSlug", () => {
  it.each([
    ["Shopping List", "shopping-list"],
    ["  Step 2: Buy milk!  ", "step-2-buy-milk"],
    ["Café & Crème", "café-crème"],
    ["snake_case - and dashes", "snake_case-and-dashes"],
    ["Заметки", "заметки"],
  ])("%j -> %j", (text, slug) => {
    expect(headingSlug(text)).toBe(slug);
  });
});

describe("fragmentSlug", () => {
  it("decodes percent-encoding and drops the #", () => {
    expect(fragmentSlug("#caf%C3%A9")).toBe("café");
    expect(fragmentSlug("Shopping-List")).toBe("shopping-list");
  });

  it("returns null for empty fragments and survives malformed encoding", () => {
    expect(fragmentSlug("")).toBeNull();
    expect(fragmentSlug("#")).toBeNull();
    expect(fragmentSlug("#100%")).toBe("100");
  });
});

describe("findHeading", () => {
  const headings = ["Intro", "Notes", "Notes", "Step-1"].map((text, i) => ({ slug: headingSlug(text), item: i }));

  it("finds the first heading with the slug", () => {
    expect(findHeading(headings, "notes")).toBe(1);
  });

  it('finds repeated headings by their "-n" suffix', () => {
    expect(findHeading(headings, "notes-1")).toBe(2);
    expect(findHeading(headings, "notes-2")).toBeNull();
  });

  it("prefers a heading whose own text ends in -n", () => {
    expect(findHeading(headings, "step-1")).toBe(3);
  });

  it("returns null when nothing matches", () => {
    expect(findHeading(headings, "missing")).toBeNull();
  });
});
