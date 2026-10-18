import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

type Katex = typeof import("katex").default;

let katexPromise: Promise<Katex> | null = null;

/** Loads KaTeX and its stylesheet (with the fonts) on first use, so notes without math don't pay for it */
function loadKatex(): Promise<Katex> {
  katexPromise ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([module]) => module.default);
  return katexPromise;
}

interface MathFormulaProps {
  /** TeX source of the formula */
  tex: string;
  /** Display (block) math instead of inline math */
  display?: boolean;
}

/**
 * Renders a TeX formula with KaTeX ($…$ and $$…$$ in notes).
 *
 * The formula text comes out of the sanitized Markdown tree as plain text; KaTeX builds the markup
 * itself from it with `trust: false` (no \href, \url, \includegraphics or \html… commands), so its
 * output contains only KaTeX's own elements, classes and inline styles and needs no sanitizing.
 * Until KaTeX has loaded (or if it fails to load) the TeX source is shown.
 */
export function MathFormula({ tex, display = false }: MathFormulaProps) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadKatex()
      .then((katex) => {
        if (cancelled) return;
        setHtml(
          katex.renderToString(tex, {
            displayMode: display,
            throwOnError: false,
            trust: false,
            strict: "ignore",
            output: "htmlAndMathml",
          })
        );
      })
      .catch(() => {
        if (!cancelled) setHtml(null);
      });
    return () => {
      cancelled = true;
    };
  }, [tex, display]);

  const className = cn("math", display ? "math-display my-4 block max-w-full overflow-x-auto overflow-y-hidden" : "math-inline");
  if (html === null) {
    return (
      <span className={cn(className, "font-mono text-[0.85em] text-muted-foreground")} data-tex={tex}>
        {display ? `$$${tex}$$` : `$${tex}$`}
      </span>
    );
  }
  // KaTeX output from text input with trust disabled (see above)
  return <span className={className} data-tex={tex} dangerouslySetInnerHTML={{ __html: html }} />;
}
