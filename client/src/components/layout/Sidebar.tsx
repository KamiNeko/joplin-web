import { useNotebooks } from "@/hooks/use-notebooks";
import { useTags } from "@/hooks/use-tags";
import { useState } from "react";
import { toast } from "sonner";
import { NotebookTree, NotebookAction } from "@/components/notebooks/NotebookTree";
import { ConfirmDialog, PromptDialog } from "@/components/common/Dialogs";
import {
  useCreateNotebook,
  useDeleteNotebook,
  useDeleteTag,
  useRenameTag,
  useUpdateNotebook,
} from "@/hooks/use-mutations";
import { TagListItem } from "@/components/tags/TagListItem";
import { findNotebookById } from "@/lib/notebooks";
import { Notebook, Tag } from "@/lib/types";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import {
  BookOpen,
  Files,
  Hash,
  Search,
  Trash2,
  X,
  FolderTree,
  Plus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { QueryError } from "@/components/common/QueryError";
import { MOBILE_SEARCH_INPUT_ID } from "@/lib/ui-constants";
import { ConnectionStatus } from "./ConnectionStatus";
import { StaleDataHint } from "@/components/common/QueryError";

interface SidebarProps {
  selectedNotebookId?: string | null;
  selectedTagId?: string | null;
  isAllNotesSelected?: boolean;
  isTrashSelected?: boolean;
  onSelectAllNotes: () => void;
  onSelectTrash: () => void;
  onSelectNotebook: (id: string) => void;
  onSelectTag: (id: string) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onCloseMobile?: () => void;
  className?: string;
}

export function Sidebar({
  selectedNotebookId,
  selectedTagId,
  isAllNotesSelected,
  isTrashSelected,
  onSelectAllNotes,
  onSelectTrash,
  onSelectNotebook,
  onSelectTag,
  searchQuery,
  onSearchChange,
  onCloseMobile,
  className,
}: SidebarProps) {
  const notebooksQuery = useNotebooks();
  const tagsQuery = useTags();
  const { data: notebooks, isLoading: isLoadingNotebooks } = notebooksQuery;
  const { data: tags, isLoading: isLoadingTags } = tagsQuery;
  const createNotebook = useCreateNotebook();
  const updateNotebook = useUpdateNotebook();
  const deleteNotebook = useDeleteNotebook();
  const renameTag = useRenameTag();
  const deleteTag = useDeleteTag();

  // Which notebook dialog is open: create (optionally under a parent), rename, or delete
  const [dialog, setDialog] = useState<
    | { kind: "create"; parent: Notebook | null }
    | { kind: "rename"; notebook: Notebook }
    | { kind: "delete"; notebook: Notebook }
    | { kind: "rename-tag"; tag: Tag }
    | { kind: "delete-tag"; tag: Tag }
    | null
  >(null);

  const handleNotebookAction = (action: NotebookAction, notebook: Notebook) => {
    if (action === "create-child") setDialog({ kind: "create", parent: notebook });
    else if (action === "rename") setDialog({ kind: "rename", notebook });
    else setDialog({ kind: "delete", notebook });
  };

  const handleCreate = (title: string) => {
    if (dialog?.kind !== "create") return;
    createNotebook.mutate(
      { title, parentId: dialog.parent?.id },
      {
        onSuccess: (nb) => {
          setDialog(null);
          onSelectNotebook(nb.id);
        },
        onError: (err) => toast.error("Could not create notebook", { description: err.message }),
      }
    );
  };

  const handleRename = (title: string) => {
    if (dialog?.kind !== "rename") return;
    updateNotebook.mutate(
      { id: dialog.notebook.id, changes: { title } },
      {
        onSuccess: () => setDialog(null),
        onError: (err) => toast.error("Could not rename notebook", { description: err.message }),
      }
    );
  };

  const handleDelete = () => {
    if (dialog?.kind !== "delete") return;
    const target = dialog.notebook;
    deleteNotebook.mutate(target.id, {
      onSuccess: () => {
        setDialog(null);
        toast.success(`"${target.title}" moved to trash`);
        // Leave the notebook view if the selected notebook was (inside) the deleted one
        if (selectedNotebookId && findNotebookById([target], selectedNotebookId)) onSelectAllNotes();
      },
      onError: (err) => toast.error("Could not delete notebook", { description: err.message }),
    });
  };

  const handleRenameTag = (title: string) => {
    if (dialog?.kind !== "rename-tag") return;
    renameTag.mutate(
      { id: dialog.tag.id, title },
      {
        onSuccess: () => setDialog(null),
        onError: (err) => toast.error("Could not rename tag", { description: err.message }),
      }
    );
  };

  const handleDeleteTag = () => {
    if (dialog?.kind !== "delete-tag") return;
    const target = dialog.tag;
    deleteTag.mutate(target.id, {
      onSuccess: () => {
        setDialog(null);
        toast.success(`Tag "${target.title}" deleted`);
        if (selectedTagId === target.id) onSelectAllNotes();
      },
      onError: (err) => toast.error("Could not delete tag", { description: err.message }),
    });
  };

  const countNotes = (nb: Notebook): number =>
    (nb.noteCount || 0) + (nb.children || []).reduce((sum, child) => sum + countNotes(child), 0);

  return (
    <aside
      className={cn(
        "flex flex-col h-full w-full bg-sidebar text-sidebar-foreground border-r border-sidebar-border select-none",
        className
      )}
    >
      {/* Brand & App Logo */}
      <div className="flex items-center justify-between px-4 py-3.5 border-b border-border/40">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 text-primary border border-primary/25 shadow-sm">
            <BookOpen className="h-5 w-5" />
          </div>
          <h1 className="text-sm font-bold text-foreground tracking-tight">
            Joplin Web
          </h1>
        </div>

        {onCloseMobile && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onCloseMobile}
            className="md:hidden h-8 w-8 text-muted-foreground hover:text-foreground"
            aria-label="Close menu"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Search Input Bar: only in the mobile slide-out menu; on desktop the header holds the search field */}
      {onCloseMobile && (
        <div className="p-3 border-b border-border/30">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              id={MOBILE_SEARCH_INPUT_ID}
              type="search"
              placeholder="Search notes..."
              aria-label="Search notes"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              onKeyDown={(e) => {
                // Close the menu so the results are visible
                if (e.key === "Enter") onCloseMobile();
              }}
              enterKeyHint="search"
              className="h-8 pl-8 pr-7 text-xs bg-background/60 border-sidebar-border focus-visible:ring-primary/60 [&::-webkit-search-cancel-button]:hidden"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => onSearchChange("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-muted-foreground hover:text-foreground"
                aria-label="Clear search text"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Navigable Sidebar Items */}
      <ScrollArea className="flex-1 px-3 py-2">
        <div className="space-y-5">
          {((notebooksQuery.isError && notebooks) || (tagsQuery.isError && tags)) && (
            <StaleDataHint
              className="px-2"
              onRetry={() => {
                if (notebooksQuery.isError) void notebooksQuery.refetch();
                if (tagsQuery.isError) void tagsQuery.refetch();
              }}
              isRetrying={notebooksQuery.isFetching || tagsQuery.isFetching}
            />
          )}
          {/* Main Views */}
          <div className="space-y-1">
            <button
              type="button"
              onClick={onSelectAllNotes}
              aria-current={isAllNotesSelected ? "page" : undefined}
              className={cn(
                "w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-sm transition-all duration-150 font-medium",
                isAllNotesSelected
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
              )}
            >
              <div className="flex items-center gap-2">
                <Files className="h-4 w-4" />
                <span>All Notes</span>
              </div>
            </button>

            <button
              type="button"
              onClick={onSelectTrash}
              aria-current={isTrashSelected ? "page" : undefined}
              className={cn(
                "w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-sm transition-all duration-150 font-medium",
                isTrashSelected
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
              )}
            >
              <div className="flex items-center gap-2">
                <Trash2 className={cn("h-4 w-4", isTrashSelected && "text-destructive")} />
                <span>Trash</span>
              </div>
            </button>
          </div>

          {/* Notebooks Section */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between px-2 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
              <span className="flex items-center gap-1.5">
                <FolderTree className="h-3 w-3" />
                Notebooks
              </span>
              <button
                type="button"
                onClick={() => setDialog({ kind: "create", parent: null })}
                className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-sidebar-accent"
                aria-label="New notebook"
                title="New notebook"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>

            {isLoadingNotebooks ? (
              <div className="space-y-2 px-2 py-1">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-5/6" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            ) : notebooksQuery.isError && !notebooks ? (
              <QueryError
                compact
                message="Couldn't load notebooks"
                onRetry={() => void notebooksQuery.refetch()}
                isRetrying={notebooksQuery.isFetching}
              />
            ) : (
              <NotebookTree
                notebooks={notebooks || []}
                selectedNotebookId={selectedNotebookId}
                onSelectNotebook={onSelectNotebook}
                onNotebookAction={handleNotebookAction}
              />
            )}
          </div>

          {/* Tags Section */}
          <div className="space-y-1.5 pt-2">
            <div className="flex items-center justify-between px-2 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
              <span className="flex items-center gap-1.5">
                <Hash className="h-3 w-3" />
                Tags
              </span>
              {tags && tags.length > 0 && (
                <span className="text-[10px] text-muted-foreground font-mono">
                  {tags.length}
                </span>
              )}
            </div>

            {isLoadingTags ? (
              <div className="space-y-2 px-2 py-1">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            ) : tagsQuery.isError && !tags ? (
              <QueryError
                compact
                message="Couldn't load tags"
                onRetry={() => void tagsQuery.refetch()}
                isRetrying={tagsQuery.isFetching}
              />
            ) : !tags || tags.length === 0 ? (
              <div className="px-2 py-1 text-xs text-muted-foreground italic">
                No tags
              </div>
            ) : (
              <div className="space-y-0.5">
                {tags.map((tag) => (
                  <TagListItem
                    key={tag.id}
                    tag={tag}
                    isSelected={selectedTagId === tag.id}
                    onSelect={() => onSelectTag(tag.id)}
                    onRename={() => setDialog({ kind: "rename-tag", tag })}
                    onDelete={() => setDialog({ kind: "delete-tag", tag })}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </ScrollArea>

      <ConnectionStatus />

      <PromptDialog
        open={dialog?.kind === "create"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={dialog?.kind === "create" && dialog.parent ? `New notebook in "${dialog.parent.title}"` : "New notebook"}
        placeholder="Notebook name"
        confirmLabel="Create"
        isPending={createNotebook.isPending}
        onSubmit={handleCreate}
      />
      <PromptDialog
        open={dialog?.kind === "rename"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Rename notebook"
        initialValue={dialog?.kind === "rename" ? dialog.notebook.title : ""}
        confirmLabel="Rename"
        isPending={updateNotebook.isPending}
        onSubmit={handleRename}
      />
      <ConfirmDialog
        open={dialog?.kind === "delete"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Move notebook to trash?"
        description={
          dialog?.kind === "delete"
            ? `"${dialog.notebook.title}" and everything in it (${countNotes(dialog.notebook)} notes, including sub-notebooks) will be moved to the trash. You can restore notes from the trash.`
            : undefined
        }
        confirmLabel="Move to trash"
        destructive
        isPending={deleteNotebook.isPending}
        onConfirm={handleDelete}
      />
      <PromptDialog
        open={dialog?.kind === "rename-tag"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Rename tag"
        initialValue={dialog?.kind === "rename-tag" ? dialog.tag.title : ""}
        confirmLabel="Rename"
        isPending={renameTag.isPending}
        onSubmit={handleRenameTag}
      />
      <ConfirmDialog
        open={dialog?.kind === "delete-tag"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Delete tag?"
        description={
          dialog?.kind === "delete-tag"
            ? `"${dialog.tag.title}" will be removed from ${dialog.tag.noteCount} note${dialog.tag.noteCount === 1 ? "" : "s"}. The notes themselves are not changed.`
            : undefined
        }
        confirmLabel="Delete tag"
        destructive
        isPending={deleteTag.isPending}
        onConfirm={handleDeleteTag}
      />
    </aside>
  );
}
