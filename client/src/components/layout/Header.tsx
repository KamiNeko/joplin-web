import { useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { ThemeToggle } from "@/components/common/ThemeToggle";
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
  LogOut,
  Menu,
  Search,
  User,
} from "lucide-react";

interface HeaderProps {
  notebookTitle?: string;
  noteTitle?: string;
  onToggleSidebar?: () => void;
  onOpenSearch?: () => void;
}

export function Header({
  notebookTitle,
  noteTitle,
  onToggleSidebar,
  onOpenSearch,
}: HeaderProps) {
  const { logout, email } = useAuth();

  // Listen for global Command+K / Ctrl+K shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        onOpenSearch?.();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onOpenSearch]);

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
          {notebookTitle ? (
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

      {/* Right: Search shortcut button, Theme toggle, and User Menu */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Quick search shortcut trigger */}
        <button
          type="button"
          onClick={onOpenSearch}
          className="hidden sm:flex items-center gap-2 h-8 px-2.5 rounded-lg border border-border/40 bg-muted/30 hover:bg-muted/60 text-xs text-muted-foreground transition-colors"
          aria-label="Open search shortcut"
        >
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <span>Quick search...</span>
          <kbd className="pointer-events-none inline-flex h-4 select-none items-center gap-1 rounded border border-border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
            <span className="text-[10px]">Ctrl</span>K
          </kbd>
        </button>

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
            <DropdownMenuItem
              onClick={() => logout()}
              className="text-destructive focus:text-destructive cursor-pointer flex items-center gap-2"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>Sign Out</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
