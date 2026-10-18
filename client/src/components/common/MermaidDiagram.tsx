import { useEffect, useRef, useState } from "react";
import { useTheme } from "@/hooks/use-theme";

type Mermaid = typeof import("mermaid").default;

let mermaidPromise: Promise<Mermaid> | null = null;
// mermaid.initialize is global, so renders run one after another
let renderQueue: Promise<unknown> = Promise.resolve();
let renderCount = 0;

/** Loads Mermaid on first use (it is large; notes without diagrams never download it) */
function loadMermaid(): Promise<Mermaid> {
  mermaidPromise ??= import("mermaid").then((module) => module.default);
  return mermaidPromise;
}

/**
 * Parses Mermaid's SVG markup into a detached element, dropping anything that could run script
 * (defence in depth: Mermaid already escapes labels in strict mode, and the CSP forbids inline
 * scripts and event handlers).
 */
function parseSvg(markup: string): SVGSVGElement | null {
  const doc = new DOMParser().parseFromString(markup, "text/html");
  const svg = doc.body.querySelector("svg");
  if (!svg) return null;
  svg.querySelectorAll("script, iframe, object, embed").forEach((element) => element.remove());
  for (const element of [svg, ...Array.from(svg.querySelectorAll("*"))]) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) element.removeAttribute(attribute.name);
      else if ((name === "href" || name === "xlink:href") && /^\s*(?:javascript|data):/i.test(attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  return svg;
}

/**
 * Renders a ```mermaid code block as a diagram. Mermaid is imported lazily and runs with
 * `securityLevel: "strict"` (no HTML in labels, no click handlers). If the diagram has a syntax
 * error, the error and the source are shown instead.
 */
export function MermaidDiagram({ code }: { code: string }) {
  const { isDark } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const id = `mermaid-diagram-${++renderCount}`;
    renderQueue = renderQueue
      .then(async () => {
        if (cancelled) return;
        const mermaid = await loadMermaid();
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          theme: isDark ? "dark" : "default",
          fontFamily: "inherit",
        });
        const { svg } = await mermaid.render(id, code);
        const element = parseSvg(svg);
        if (cancelled || !containerRef.current) return;
        if (!element) throw new Error("Mermaid returned no diagram");
        element.style.maxWidth = "100%";
        element.style.height = "auto";
        containerRef.current.replaceChildren(element);
        setError(null);
        setRendered(true);
      })
      .catch((err: unknown) => {
        // Mermaid can leave its temporary render container behind on errors
        document.getElementById(`d${id}`)?.remove();
        if (cancelled) return;
        containerRef.current?.replaceChildren();
        setRendered(false);
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [code, isDark]);

  return (
    <div className="my-4">
      <div
        ref={containerRef}
        role="img"
        aria-label="Mermaid diagram"
        hidden={!rendered}
        className="mermaid-diagram flex justify-center overflow-x-auto rounded-xl border border-border/60 bg-card p-4"
      />
      {!rendered && (
        <div className="rounded-xl border border-border/60 bg-[hsl(var(--code-background))] overflow-hidden">
          {error && (
            <p className="m-0! border-b border-border/40 px-4 py-2 text-xs text-destructive">
              Mermaid diagram could not be rendered: {error}
            </p>
          )}
          <pre className="m-0 overflow-x-auto p-4 text-sm font-mono leading-relaxed text-[hsl(var(--code-foreground))]">
            <code>{code}</code>
          </pre>
        </div>
      )}
    </div>
  );
}
