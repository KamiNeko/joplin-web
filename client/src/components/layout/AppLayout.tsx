import React, { useEffect, useRef, useState } from "react";
import { Header } from "./Header";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { MOBILE_SEARCH_INPUT_ID } from "@/lib/ui-constants";
import { NotebookBreadcrumb } from "@/lib/types";
import { useAutoRefresh } from "@/hooks/use-connection";
import { useAiStatus } from "@/hooks/use-workspace";
import { ConnectionBanner } from "./ConnectionBanner";
import { ReadOnlyBanner } from "./ReadOnlyBanner";
import { CommandPalette } from "@/components/common/CommandPalette";
import { AskNotesDrawer } from "@/components/ai/AskNotesDrawer";

interface AppLayoutProps {
  sidebar: (props: {
    onCloseMobile?: () => void;
    aiEnabled?: boolean;
    onOpenAskAi?: () => void;
  }) => React.ReactNode;
  children: React.ReactNode;
  notebookTitle?: string;
  notebookPath?: NotebookBreadcrumb[];
  noteTitle?: string;
  onSelectNotebook?: (notebookId: string) => void;
  defaultAiNotebookId?: string | null;
  defaultAiTagId?: string | null;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  /** Search results are shown instead of the selected list */
  isSearchActive?: boolean;
  /** The account can't be written (end-to-end encryption): shows a banner with `readOnlyReason` */
  readOnly?: boolean;
  readOnlyReason?: string | null;
}

export function AppLayout({
  sidebar,
  children,
  notebookTitle,
  notebookPath,
  noteTitle,
  onSelectNotebook,
  defaultAiNotebookId = null,
  defaultAiTagId = null,
  searchQuery,
  onSearchChange,
  isSearchActive = false,
  readOnly = false,
  readOnlyReason = null,
}: AppLayoutProps) {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [askAiOpen, setAskAiOpen] = useState(false);
  // Set when the menu is opened via Ctrl+K, so its search field gets focus instead of the first item
  const focusSearchOnOpen = useRef(false);
  useAutoRefresh();
  const { data: aiStatus } = useAiStatus();
  const aiEnabled = Boolean(aiStatus?.enabled);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const lower = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && ((lower === "p" && !e.shiftKey) || (lower === "k" && e.shiftKey))) {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const openAskAi = () => setAskAiOpen(true);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      {/* Desktop Persistent Sidebar */}
      <div className="hidden md:flex w-64 lg:w-72 shrink-0 h-full">
        {sidebar({ aiEnabled, onOpenAskAi: openAskAi })}
      </div>

      {/* Mobile Slide-over Sidebar (Sheet). The sidebar has its own close button, so the
          sheet's built-in one (its first child) is hidden. */}
      <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
        <SheetContent
          side="left"
          className="p-0 w-72 bg-card border-r border-border/40 [&>button:first-child]:hidden"
          onOpenAutoFocus={(e) => {
            if (!focusSearchOnOpen.current) return;
            focusSearchOnOpen.current = false;
            const input = document.getElementById(MOBILE_SEARCH_INPUT_ID);
            if (input) {
              e.preventDefault();
              input.focus();
            }
          }}
        >
          <SheetTitle className="sr-only">Navigation Menu</SheetTitle>
          {sidebar({ onCloseMobile: () => setMobileSidebarOpen(false), aiEnabled, onOpenAskAi: openAskAi })}
        </SheetContent>
      </Sheet>

      {/* Right Column: Header + Main View */}
      <div className="flex flex-col flex-1 h-full min-w-0 overflow-hidden">
        <Header
          notebookTitle={notebookTitle}
          notebookPath={notebookPath}
          noteTitle={noteTitle}
          isSearchActive={isSearchActive}
          onToggleSidebar={() => setMobileSidebarOpen(true)}
          onSelectNotebook={onSelectNotebook}
          onOpenCommandPalette={() => setPaletteOpen(true)}
          onOpenAskAi={openAskAi}
          aiEnabled={aiEnabled}
          searchQuery={searchQuery}
          onSearchChange={onSearchChange}
          onOpenMobileSearch={() => {
            if (mobileSidebarOpen) {
              document.getElementById(MOBILE_SEARCH_INPUT_ID)?.focus();
              return;
            }
            focusSearchOnOpen.current = true;
            setMobileSidebarOpen(true);
          }}
        />
        <ConnectionBanner />
        {readOnly && <ReadOnlyBanner reason={readOnlyReason} />}
        <main className="flex-1 min-h-0 overflow-hidden">
          {children}
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        aiEnabled={aiEnabled}
        onOpenAskAi={openAskAi}
      />

      {aiEnabled && (
        <AskNotesDrawer
          open={askAiOpen}
          onOpenChange={setAskAiOpen}
          defaultNotebookId={defaultAiNotebookId}
          defaultTagId={defaultAiTagId}
        />
      )}
    </div>
  );
}
