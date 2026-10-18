import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Notebook, Tag } from "@/lib/types";
import { TagListItem } from "@/components/tags/TagListItem";
import { NotebookTree } from "./NotebookTree";

afterEach(cleanup);

const notebook = (id: string, title: string, encrypted = false): Notebook => ({
  id: id.repeat(32),
  title,
  parentId: "",
  children: [],
  noteCount: 1,
  encrypted,
});

describe("encrypted items in the sidebar", () => {
  it("offers no actions for an encrypted notebook", () => {
    render(
      <NotebookTree
        notebooks={[notebook("a", "Work"), notebook("b", "Encrypted notebook", true)]}
        onSelectNotebook={vi.fn()}
        onNotebookAction={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: "Actions for Work" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Encrypted notebook/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Actions for Encrypted notebook" })).toBeNull();
  });

  it("offers no notebook actions on a read-only account", () => {
    render(<NotebookTree notebooks={[notebook("a", "Work")]} onSelectNotebook={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Actions for Work" })).toBeNull();
  });

  it("offers no actions for an encrypted tag or without handlers", () => {
    const tag: Tag = { id: "c".repeat(32), title: "Encrypted tag", noteCount: 1, encrypted: true };
    render(<TagListItem tag={tag} isSelected={false} onSelect={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Actions for tag Encrypted tag" })).toBeNull();
    cleanup();

    const plain: Tag = { id: "d".repeat(32), title: "books", noteCount: 2 };
    render(<TagListItem tag={plain} isSelected={false} onSelect={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Actions for tag books" })).toBeNull();
  });
});
