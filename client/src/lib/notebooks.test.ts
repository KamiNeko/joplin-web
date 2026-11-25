import { describe, expect, it } from "vitest";
import { Notebook } from "./types";
import { collectNotebookIds, findNotebookAncestors } from "./notebooks";

const id = (c: string) => c.repeat(32);
const nb = (c: string, title: string, children: Notebook[] = []): Notebook => ({
  id: id(c),
  title,
  parentId: "",
  children,
  noteCount: 0,
});

const soups = nb("4", "Soups");
const recipes = nb("3", "Recipes", [soups]);
const personal = nb("1", "Personal", [recipes]);
const work = nb("2", "Work");
const tree = [personal, work];

describe("findNotebookAncestors", () => {
  it("returns empty for top-level, missing, null, or undefined targets", () => {
    expect(findNotebookAncestors(tree, work.id)).toEqual([]);
    expect(findNotebookAncestors(tree, personal.id)).toEqual([]);
    expect(findNotebookAncestors(tree, id("9"))).toEqual([]);
    expect(findNotebookAncestors(tree, null)).toEqual([]);
    expect(findNotebookAncestors(tree, undefined)).toEqual([]);
    expect(findNotebookAncestors(undefined, soups.id)).toEqual([]);
  });

  it("returns ancestor IDs from root to direct parent in order", () => {
    expect(findNotebookAncestors(tree, recipes.id)).toEqual([personal.id]);
    expect(findNotebookAncestors(tree, soups.id)).toEqual([personal.id, recipes.id]);
  });
});

describe("collectNotebookIds", () => {
  it("collects every notebook ID in nested trees", () => {
    expect([...collectNotebookIds(tree)]).toEqual([personal.id, recipes.id, soups.id, work.id]);
    expect([...collectNotebookIds([])]).toEqual([]);
    expect([...collectNotebookIds(undefined)]).toEqual([]);
  });
});
