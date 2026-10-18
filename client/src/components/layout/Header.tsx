import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { SEARCH_SYNTAX_HINT } from "@/lib/ui-constants";
import { ThemeToggle } from "@/components/common/ThemeToggle";
import { AboutDialog } from "@/components/common/Dialogs";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  ChevronRight,
  Folder,
  Info,
  LogOut,
  Menu,
  Search,
  User,
  X,
} from "lucide-react";

interface HeaderProps {
  notebookTitle?: string;
  noteTitle?: string;
  /** Shows "Search" in the breadcrumb while search results replace the list */
  isSearchActive?: boolean;
  onToggleSidebar?: () => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  /** Ctrl+K on small screens, where the header search field is hidden */
  onOpenMobileSearch?: () => void;
}

export function Header({
  notebookTitle,
  noteTitle,
  isSearchActive = false,
  onToggleSidebar,
  searchQuery,
  onSearchChange,
  onOpenMobileSearch,
}: HeaderProps) {
  const { logout, email } = useAuth();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [aboutOpen, setAboutOpen] = useState(false);

  // Ctrl+K / Cmd+K focuses the search field (or opens the mobile menu that holds it). In the note
  // editor it inserts a link instead; the editor marks the event as handled then.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const input = searchInputRef.current;
        if (input && input.offsetParent !== null) {
          input.focus();
          input.select();
        } else {
          onOpenMobileSearch?.();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onOpenMobileSearch]);

  return (
    <header className="h-14 border-b border-border/40 bg-card/60 backdrop-blur-md px-4 flex items-center justify-between gap-4 z-20">
      {/* Left: Mobile sidebar toggle & breadcrumbs */}
      <div className="flex items-center gap-3 min-w-0">
        {onToggleSidebar && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleSidebar}
            className="md:hidden h-8 w-8 text-muted-foreground hover:text-foreground shrink-0"
            aria-label="Toggle navigation menu"
          >
            <Menu className="h-4 w-4" />
          </Button>
        )}

        {/* Breadcrumb path */}
        <nav
          aria-label="Breadcrumb"
          className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0"
        >
          {isSearchActive ? (
            <div className="flex items-center gap-1.5 shrink-0 text-foreground/80 font-medium">
              <Search className="h-3.5 w-3.5 text-primary" />
              <span>Search</span>
            </div>
          ) : notebookTitle ? (
            <div className="flex items-center gap-1.5 shrink-0 text-foreground/80 font-medium">
              <Folder className="h-3.5 w-3.5 text-primary" />
              <span className="truncate max-w-[140px] sm:max-w-[200px]">
                {notebookTitle}
              </span>
            </div>
          ) : (
            <span className="text-foreground/80 font-medium">All Notes</span>
          )}

          {noteTitle && (
            <>
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
              <span className="font-semibold text-foreground truncate max-w-[180px] sm:max-w-[320px]">
                {noteTitle}
              </span>
            </>
          )}
        </nav>
      </div>

      {/* Right: Search field, Theme toggle, and User Menu */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Search field (desktop; on mobile the search lives in the slide-out menu) */}
        <div className="relative hidden md:block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            ref={searchInputRef}
            type="search"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                onSearchChange("");
                e.currentTarget.blur();
              }
            }}
            placeholder="Search notes..."
            title={SEARCH_SYNTAX_HINT}
            aria-label="Search notes"
            className="h-8 w-56 lg:w-72 rounded-lg border border-border/40 bg-muted/30 pl-8 pr-14 text-xs text-foreground placeholder:text-muted-foreground outline-hidden transition-colors hover:bg-muted/50 focus:bg-background focus:border-primary/50 focus:ring-1 focus:ring-primary/40 [&::-webkit-search-cancel-button]:hidden"
          />
          {searchQuery ? (
            <button
              type="button"
              onClick={() => {
                onSearchChange("");
                searchInputRef.current?.focus();
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : (
            <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-4 select-none items-center gap-1 rounded border border-border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
              Ctrl K
            </kbd>
          )}
        </div>

        {/* Theme toggle */}
        <ThemeToggle />

        {/* User Account Menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-full border border-border/40 hover:ring-2 hover:ring-primary/40 transition-all"
              aria-label="User account menu"
            >
              <Avatar className="h-8 w-8">
                <AvatarFallback className="bg-primary/15 text-primary text-xs font-semibold">
                  {email ? email.charAt(0).toUpperCase() : <User className="h-4 w-4" />}
                </AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60 text-xs">
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col space-y-1">
                <p className="text-[11px] leading-none text-muted-foreground">
                  Signed in as
                </p>
                <p
                  className="text-xs font-semibold leading-tight text-foreground truncate"
                  title={email ?? undefined}
                >
                  {email ?? "Joplin Account"}
                </p>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setAboutOpen(true)} className="cursor-pointer flex items-center gap-2">
              <Info className="h-3.5 w-3.5" />
              <span>About Joplin Web</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => logout()}
              className="text-destructive focus:text-destructive cursor-pointer flex items-center gap-2"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>Sign Out</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
      </div>
    </header>
  );
}
