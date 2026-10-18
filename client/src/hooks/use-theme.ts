import { createContext, useContext } from "react";

export type Theme = "dark" | "light" | "system";

export interface ThemeProviderState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  isDark: boolean;
}

const initialState: ThemeProviderState = {
  theme: "dark",
  setTheme: () => null,
  isDark: true,
};

export const ThemeProviderContext = createContext<ThemeProviderState>(initialState);

/**
 * The current theme and a setter; needs a ThemeProvider above.
 */
export const useTheme = () => {
  const context = useContext(ThemeProviderContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
};
