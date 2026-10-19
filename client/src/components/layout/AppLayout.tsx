import React, { useRef, useState } from "react";
import { Header } from "./Header";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { MOBILE_SEARCH_INPUT_ID } from "@/lib/ui-constants";
import { useAutoRefresh } from "@/hooks/use-connection";
import { ConnectionBanner } from "./ConnectionBanner";
import { ReadOnlyBanner } from "./ReadOnlyBanner";

interface AppLayoutProps {
  sidebar: (props: { onCloseMobile?: () => void }) => React.ReactNode;
  children: React.ReactNode;
  notebookTitle?: string;
  noteTitle?: string;
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
  noteTitle,
  searchQuery,
  onSearchChange,
  isSearchActive = false,
  readOnly = false,
  readOnlyReason = null,
}: AppLayoutProps) {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  // Set when the menu is opened via Ctrl+K, so its search field gets focus instead of the first item
  const focusSearchOnOpen = useRef(false);
  useAutoRefresh();

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      {/* Desktop Persistent Sidebar */}
      <div className="hidden md:flex w-64 lg:w-72 shrink-0 h-full">
        {sidebar({})}
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
          {sidebar({ onCloseMobile: () => setMobileSidebarOpen(false) })}
        </SheetContent>
      </Sheet>

      {/* Right Column: Header + Main View */}
      <div className="flex flex-col flex-1 h-full min-w-0 overflow-hidden">
        <Header
          notebookTitle={notebookTitle}
          noteTitle={noteTitle}
          isSearchActive={isSearchActive}
          onToggleSidebar={() => setMobileSidebarOpen(true)}
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
    </div>
  );
}
