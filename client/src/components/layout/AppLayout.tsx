import React, { useState } from "react";
import { Header } from "./Header";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

interface AppLayoutProps {
  sidebar: (props: { onCloseMobile?: () => void }) => React.ReactNode;
  children: React.ReactNode;
  notebookTitle?: string;
  noteTitle?: string;
  onOpenSearch?: () => void;
}

export function AppLayout({
  sidebar,
  children,
  notebookTitle,
  noteTitle,
  onOpenSearch,
}: AppLayoutProps) {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      {/* Desktop Persistent Sidebar */}
      <div className="hidden md:flex w-64 lg:w-72 shrink-0 h-full border-r border-border/40">
        {sidebar({})}
      </div>

      {/* Mobile Slide-over Sidebar (Sheet) */}
      <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
        <SheetContent side="left" className="p-0 w-72 bg-card border-r border-border/40">
          <SheetTitle className="sr-only">Navigation Menu</SheetTitle>
          {sidebar({ onCloseMobile: () => setMobileSidebarOpen(false) })}
        </SheetContent>
      </Sheet>

      {/* Right Column: Header + Main View */}
      <div className="flex flex-col flex-1 h-full min-w-0 overflow-hidden">
        <Header
          notebookTitle={notebookTitle}
          noteTitle={noteTitle}
          onToggleSidebar={() => setMobileSidebarOpen(true)}
          onOpenSearch={onOpenSearch}
        />
        <main className="flex-1 h-[calc(100vh-3.5rem)] overflow-hidden">
          {children}
        </main>
      </div>
    </div>
  );
}
