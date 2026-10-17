import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTheme } from "./ThemeProvider";

interface ThemeToggleProps {
  className?: string;
}

export function ThemeToggle({ className }: ThemeToggleProps) {
  const { theme, setTheme, isDark } = useTheme();

  const toggleTheme = () => {
    setTheme(isDark ? "light" : "dark");
  };

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleTheme}
            className={`relative h-9 w-9 rounded-lg hover:bg-accent/80 transition-colors ${className ?? ""}`}
            aria-label={`Switch to ${isDark ? "light" : "dark"} mode`}
          >
            <Sun
              className={`h-[1.2rem] w-[1.2rem] transition-all duration-300 ${
                isDark
                  ? "rotate-90 scale-0 opacity-0"
                  : "rotate-0 scale-100 opacity-100 text-amber-500"
              }`}
            />
            <Moon
              className={`absolute h-[1.2rem] w-[1.2rem] transition-all duration-300 ${
                isDark
                  ? "rotate-0 scale-100 opacity-100 text-primary"
                  : "-rotate-90 scale-0 opacity-0"
              }`}
            />
            <span className="sr-only">Toggle theme (currently {theme})</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>Switch to {isDark ? "light" : "dark"} mode</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
