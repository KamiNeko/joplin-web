import React, { useEffect, useRef, useState } from "react";
import { Theme, ThemeProviderContext, ThemeProviderState } from "@/hooks/use-theme";

interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
}

export function ThemeProvider({
  children,
  defaultTheme = "dark",
  storageKey = "joplin-theme",
}: ThemeProviderProps) {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem(storageKey) as Theme) || defaultTheme
  );

  const isFirstApply = useRef(true);

  useEffect(() => {
    const root = window.document.documentElement;
    // Animate colours only while the theme actually switches (not on first paint)
    let transitionTimer: number | undefined;
    if (!isFirstApply.current) {
      root.classList.add("theme-transition");
      transitionTimer = window.setTimeout(() => root.classList.remove("theme-transition"), 200);
    }
    isFirstApply.current = false;
    root.classList.remove("light", "dark");

    if (theme === "system") {
      const systemTheme = window.matchMedia("(prefers-color-scheme: dark)")
        .matches
        ? "dark"
        : "light";
      root.classList.add(systemTheme);
    } else {
      root.classList.add(theme);
    }

    return () => {
      window.clearTimeout(transitionTimer);
      root.classList.remove("theme-transition");
    };
  }, [theme]);

  const value: ThemeProviderState = {
    theme,
    setTheme: (newTheme: Theme) => {
      localStorage.setItem(storageKey, newTheme);
      setTheme(newTheme);
    },
    isDark:
      theme === "dark" ||
      (theme === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches),
  };

  return (
    <ThemeProviderContext.Provider value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}
