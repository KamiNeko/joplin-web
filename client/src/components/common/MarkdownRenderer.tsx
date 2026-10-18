import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy, ExternalLink } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, downloadResource, getNote, getResourceIdFromUrl, getResourceUrl } from "@/lib/api";
import { ResourceImage } from "./ResourceImage";
import { cn } from "@/lib/utils";
import type { TaskLocation } from "@/lib/tasks";
import { useLocation, useNavigate } from "react-router-dom";
import { findHeading, fragmentSlug, headingSlug } from "@/lib/heading-slug";
import { remarkJoplinMarkup, remarkJoplinMath } from "@/lib/markdown-extensions";
import { MathFormula } from "./MathFormula";
import { MermaidDiagram } from "./MermaidDiagram";

interface MarkdownRendererProps {
  content: string;
  className?: string;
  /**
   * Renders `content` as HTML instead of Markdown, for notes with `markup_language: 2` (e.g. pages
   * saved with the Joplin Web Clipper). Same sanitizing and `:/id` handling, no Markdown parsing.
   */
  html?: boolean;
  /**
   * Makes task-list checkboxes clickable. `location` is where the task item starts in `content`
   * (see `setTaskChecked` in lib/tasks).
   */
  onToggleTask?: (location: TaskLocation, checked: boolean) => void;
}

interface SourcePosition {
  start: { line: number; column: number; offset?: number };
}

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  position?: SourcePosition;
}

/** Concatenated text of a hast subtree */
function hastText(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return (node as { value?: string }).value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

/** Class names of a hast element as a list */
function hastClasses(node: HastNode | undefined): string[] {
  const value = node?.properties?.className;
  return Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(/\s+/) : [];
}

interface MdastNode {
  type: string;
  checked?: boolean | null;
  children?: MdastNode[];
  position?: SourcePosition;
}

interface PluginFile {
  data: Record<string, unknown>;
}

/**
 * Remark plugin that records the source offsets of the list items remark-gfm parsed as tasks,
 * so rehypeTaskLocation only marks checkboxes that come from real Markdown task items.
 */
function remarkTaskItems() {
  return (tree: MdastNode, file: PluginFile) => {
    const offsets = new Set<number>();
    const walk = (node: MdastNode) => {
      const offset = node.position?.start.offset;
      if (node.type === "listItem" && typeof node.checked === "boolean" && offset !== undefined) {
        offsets.add(offset);
      }
      node.children?.forEach(walk);
    };
    walk(tree);
    file.data.taskItemOffsets = offsets;
  };
}

/**
 * Remark plugin for HTML notes: replaces whatever remark parsed with one raw HTML node holding the
 * whole note, so rehype-raw parses it as HTML. Markdown rules never apply (an HTML block ending at
 * a blank line, indented code, `*emphasis*`), but sanitizing and the components stay the same.
 */
function remarkWholeHtml() {
  return (tree: MdastNode & { children: unknown[] }, file: { value: unknown }) => {
    tree.children = [{ type: "html", value: String(file.value) }];
  };
}

/**
 * Rehype plugin that stores the source line/column of each task item on its checkbox
 * (data-task-line, data-task-column), so a click toggles exactly the "[ ]" the parser rendered.
 * Runs after sanitizing; checkboxes in raw HTML get no location and stay read-only.
 */
function rehypeTaskLocation() {
  return (tree: HastNode, file: PluginFile) => {
    const taskOffsets = file.data.taskItemOffsets;
    if (!(taskOffsets instanceof Set)) return;
    const findCheckbox = (node: HastNode): HastNode | null => {
      for (const child of node.children ?? []) {
        if (child.type !== "element") continue;
        if (child.tagName === "input" && child.properties?.type === "checkbox") return child;
        // The checkbox sits directly in the <li>, or in its first <p> for loose lists
        if (child.tagName === "p") return findCheckbox(child);
        return null;
      }
      return null;
    };
    const walk = (node: HastNode) => {
      const start = node.position?.start;
      if (node.type === "element" && node.tagName === "li" && start && taskOffsets.has(start.offset)) {
        const checkbox = findCheckbox(node);
        if (checkbox?.properties) {
          checkbox.properties.dataTaskLine = start.line;
          checkbox.properties.dataTaskColumn = start.column;
        }
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

// Classes note content may set. Anything else (e.g. Tailwind's "fixed inset-0") could let a note
// restyle or overlay the app UI. rehype-highlight runs after sanitizing and adds its own classes.
// "math-inline"/"math-display" mark remark-math's formulas, which MathFormula renders with KaTeX.
const ALLOWED_CONTENT_CLASS = /^(?:(?:language-|hljs)[\w-]*|math-inline|math-display)$/;

// Custom sanitize schema allowing highlight classes and common markdown elements
const sanitizeSchema = {
  ...defaultSchema,
  // Drop these elements with their contents (CSS or a page title would otherwise show up as text)
  strip: [...(defaultSchema.strip ?? []), "style", "title"],
  tagNames: [...(defaultSchema.tagNames ?? []), "mark"],
  attributes: {
    ...defaultSchema.attributes,
    // Replaces the default className rule (only "language-*"): the first rule for a property wins
    code: [
      ...(defaultSchema.attributes?.code || []).filter((rule) => !Array.isArray(rule) || rule[0] !== "className"),
      ["className", ALLOWED_CONTENT_CLASS],
    ],
    span: [...(defaultSchema.attributes?.span || []), ["className", ALLOWED_CONTENT_CLASS]],
    div: [...(defaultSchema.attributes?.div || []), ["className", ALLOWED_CONTENT_CLASS]],
    img: [
      ...(defaultSchema.attributes?.img || []),
      "src",
      "alt",
      "title",
      "width",
      "height",
      "loading",
    ],
    input: [
      ...(defaultSchema.attributes?.input || []),
      ["type", "checkbox"],
      "checked",
      "disabled",
    ],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: ["http", "https", "data", "blob"],
    href: ["http", "https", "mailto", "tel"],
  },
};

/**
 * Preprocesses markdown text to translate Joplin-specific `:/<id>` links into web-compatible URLs.
 */
function preprocessJoplinMarkdown(raw: string): string {
  if (!raw) return "";

  // Replace Markdown image syntax: ![alt](:/id "title") -> ![alt](/api/resources/id "title").
  // The ":/" form has to go: the sanitizer would drop it as an unknown URL protocol.
  // All rewrites keep whitespace and line breaks, so line/column positions of the result match
  // the original (task checkboxes map clicks back to the source by position).
  let transformed = raw.replace(
    /!\[([^\]]*)\]\((\s*):\/?([0-9a-fA-F]{32})(\s+"[^"]*")?(\s*)\)/g,
    (_, alt, lead, id, title = "", trail) => `![${alt}](${lead}${getResourceUrl(id)}${title}${trail})`
  );

  // Replace links to notes/attachments: [text](:/id) -> /joplin-item/id, keeping a "#heading"
  // fragment. A ":/" href would be dropped by the sanitizer as an unknown protocol.
  transformed = transformed.replace(
    /(^|[^!])\[([^\]]*)\]\((\s*):\/?([0-9a-fA-F]{32})(#[^\s()"'<>]*)?(\s+"[^"]*")?(\s*)\)/g,
    (_, before, text, lead, id, fragment = "", title = "", trail) =>
      `${before}[${text}](${lead}${JOPLIN_ITEM_PATH}${id.toLowerCase()}${fragment}${title}${trail})`
  );

  return preprocessJoplinHtml(transformed);
}

/**
 * Translates `:/<id>` references in HTML (`<img src>`, `<a href>`) into web-compatible URLs.
 * Used for HTML notes and for the HTML inside Markdown notes.
 */
function preprocessJoplinHtml(raw: string): string {
  if (!raw) return "";

  // Replace HTML image src: <img src=":/id" ...> -> <img src="/api/resources/id" ...>
  let transformed = raw.replace(
    /<img([^>]{1,500}?)src=["']:\/?([a-zA-Z0-9_-]+)["']([^>]*)>/gi,
    (_, before, id, after) => `<img${before}src="${getResourceUrl(id)}"${after}>`
  );

  // Replace links to notes/attachments: <a href=":/id"> -> /joplin-item/id, keeping a "#heading" fragment
  transformed = transformed.replace(
    /<a([^>]{1,500}?)href=(["']):\/?([0-9a-fA-F]{32})(#[^\s"'<>]*)?\2/gi,
    (_, before, _quote, id, fragment = "") => `<a${before}href="${JOPLIN_ITEM_PATH}${id.toLowerCase()}${fragment}"`
  );

  return transformed;
}

const JOPLIN_ITEM_PATH = "/joplin-item/";
const JOPLIN_ITEM_HREF = /^\/joplin-item\/([0-9a-f]{32})(?:#(.*))?$/;

/** Flattens rendered link children to plain text (used as the download file name) */
function textContent(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) return textContent(node.props.children);
  return "";
}

/**
 * Prettified code block with syntax highlight and copy-to-clipboard action.
 */
interface CodeBlockProps extends React.HTMLAttributes<HTMLElement> {
  inline?: boolean;
  className?: string;
  children?: React.ReactNode;
}

function CodeBlock({ inline, className, children, ...props }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const classes = className?.split(/\s+/) ?? [];
  if (classes.includes("math-inline") || classes.includes("math-display")) {
    return <MathFormula tex={textContent(children)} display={classes.includes("math-display")} />;
  }

  const match = /language-(\w+)/.exec(className || "");
  const language = match ? match[1] : "";
  const codeString = String(children).replace(/\n$/, "");

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(codeString);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore clipboard write failure
    }
  };

  if (inline || !className?.includes("language-") && !codeString.includes("\n")) {
    return (
      <code
        className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-primary border border-border/60"
        {...props}
      >
        {children}
      </code>
    );
  }

  return (
    <div className="relative group my-4 rounded-xl border border-border/60 bg-[hsl(var(--code-background))] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border/40 bg-foreground/3 text-xs text-muted-foreground font-mono">
        <span className="uppercase tracking-wider font-semibold text-primary/80">
          {language || "text"}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs hover:bg-muted/60 transition-colors text-muted-foreground hover:text-foreground"
          aria-label="Copy code to clipboard"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-success" />
              <span className="text-success">Copied!</span>
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <div className="p-4 overflow-x-auto text-sm font-mono leading-relaxed text-[hsl(var(--code-foreground))]">
        <code className={className} {...props}>
          {children}
        </code>
      </div>
    </div>
  );
}

/**
 * Reusable Markdown renderer for Joplin notes with code highlighting,
 * resource resolving, and beautiful typography.
 */
export function MarkdownRenderer({ content, className, html = false, onToggleTask }: MarkdownRendererProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const containerRef = useRef<HTMLDivElement>(null);
  const scrolledForRef = useRef<string | null>(null);

  // ":/id" can point to a note or an attachment; only the server knows which
  const openJoplinItem = async (id: string, label: string, slug: string | null) => {
    try {
      await queryClient.fetchQuery({ queryKey: ["note", id], queryFn: () => getNote(id), staleTime: 15 * 1000 });
      navigate(`/notes/${id}${slug ? `#${encodeURIComponent(slug)}` : ""}`);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 404) {
        toast.error("Could not open link", { description: err instanceof Error ? err.message : undefined });
        return;
      }
      try {
        await downloadResource(id, label.trim() || "attachment");
      } catch {
        toast.error("This link points to a note or attachment that no longer exists");
      }
    }
  };
  const processedContent = html ? preprocessJoplinHtml(content) : preprocessJoplinMarkdown(content);

  // A link to a heading ("/notes/<id>#<slug>") scrolls to it once per navigation, not on every
  // re-render (the editor preview re-renders while typing)
  useEffect(() => {
    const slug = fragmentSlug(location.hash);
    const container = containerRef.current;
    if (!slug || !container || scrolledForRef.current === location.key) return;
    const headings = Array.from(container.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")).map((item) => ({
      slug: headingSlug(item.textContent ?? ""),
      item,
    }));
    const target = findHeading(headings, slug);
    if (!target) return;
    scrolledForRef.current = location.key;
    target.scrollIntoView({ block: "start" });
  }, [location.hash, location.key, processedContent]);

  return (
    <div ref={containerRef} className={`prose-content text-foreground leading-relaxed ${className ?? ""}`}>
      <ReactMarkdown
        remarkPlugins={
          html
            ? [remarkWholeHtml]
            : [
                // Joplin uses a single "~" for subscript, only "~~" is strikethrough
                [remarkGfm, { singleTilde: false }],
                remarkMath,
                remarkJoplinMath,
                remarkJoplinMarkup,
                remarkTaskItems,
              ]
        }
        rehypePlugins={[
          rehypeRaw,
          [rehypeSanitize, sanitizeSchema],
          rehypeTaskLocation,
          rehypeHighlight,
        ]}
        components={{
          code: CodeBlock,
          pre: ({ node, children, ...props }) => {
            const code = (node as HastNode | undefined)?.children?.find((child) => child.type === "element");
            const classes = hastClasses(code);
            if (code?.tagName === "code" && classes.includes("language-mermaid")) {
              return <MermaidDiagram code={hastText(code).replace(/\n$/, "")} />;
            }
            // Display math renders as a block of its own (see CodeBlock)
            if (code?.tagName === "code" && classes.includes("math-display")) return <>{children}</>;
            return <pre {...props}>{children}</pre>;
          },
          mark: ({ children, ...props }) => (
            <mark {...props} className="rounded-sm bg-warning/30 px-0.5 text-foreground">
              {children}
            </mark>
          ),
          a: ({ href, children, ...props }) => {
            if (!href) return <a {...props}>{children}</a>;

            // Links to Joplin notes or attachments (":/id", rewritten in preprocessing)
            if (href.startsWith(JOPLIN_ITEM_PATH)) {
              const match = JOPLIN_ITEM_HREF.exec(href);
              if (!match) return <span>{children}</span>;
              const [, itemId, fragment] = match;
              return (
                <button
                  type="button"
                  onClick={() => void openJoplinItem(itemId, textContent(children), fragmentSlug(fragment ?? ""))}
                  className="inline-flex items-center text-primary underline underline-offset-4 hover:text-primary/80 transition-colors font-medium"
                >
                  {children}
                </button>
              );
            }

            const isExternal = href.startsWith("http://") || href.startsWith("https://");
            return (
              <a
                href={href}
                target={isExternal ? "_blank" : undefined}
                rel={isExternal ? "noopener noreferrer" : undefined}
                className="inline-flex items-center gap-0.5 text-primary hover:underline hover:text-primary/80 transition-colors font-medium cursor-pointer"
                {...props}
              >
                {children}
                {isExternal && <ExternalLink className="h-3 w-3 inline-block opacity-70 ml-0.5" />}
              </a>
            );
          },
          img: ({ src, alt, title, width, height }) => {
            const imageClass =
              "rounded-lg border border-border/40 max-w-full h-auto object-contain shadow-xs bg-muted/20";
            // Joplin resources need the session, so they are loaded through the API
            const resourceId = getResourceIdFromUrl(src);
            return (
              <span className="block my-4">
                {resourceId ? (
                  <ResourceImage resourceId={resourceId} alt={alt} title={title} width={width} height={height} className={imageClass} />
                ) : (
                  <img src={src} alt={alt ?? ""} title={title} width={width} height={height} className={imageClass} loading="lazy" />
                )}
              </span>
            );
          },
          table: ({ children, ...props }) => (
            <div className="my-6 w-full overflow-x-auto rounded-lg border border-border/50 shadow-xs">
              <table className="w-full text-left text-sm" {...props}>
                {children}
              </table>
            </div>
          ),
          thead: ({ children, ...props }) => (
            <thead className="bg-muted/60 border-b border-border/50 text-foreground font-semibold" {...props}>
              {children}
            </thead>
          ),
          th: ({ children, ...props }) => (
            <th className="px-4 py-2.5 text-sm font-semibold text-foreground" {...props}>
              {children}
            </th>
          ),
          td: ({ children, ...props }) => (
            <td className="px-4 py-2.5 text-sm border-t border-border/30 text-foreground/90" {...props}>
              {children}
            </td>
          ),
          tr: ({ children, ...props }) => (
            <tr className="hover:bg-muted/30 transition-colors even:bg-muted/10" {...props}>
              {children}
            </tr>
          ),
          blockquote: ({ children, ...props }) => (
            <blockquote
              className="my-4 border-l-[3px] border-primary/60 bg-muted/40 py-2.5 px-4 rounded-r-lg italic text-foreground/90"
              {...props}
            >
              {children}
            </blockquote>
          ),
          ul: ({ children, className, ...props }) => {
            // Task lists drop the bullet (the checkbox is the marker); nested ones stay indented
            const isTaskList = className?.includes("contains-task-list");
            return (
              <ul
                {...props}
                className={cn(
                  "my-3 ml-6 list-disc space-y-1 text-foreground/90",
                  isTaskList && "ml-0 list-none in-[li]:ml-6 in-[li]:my-1",
                  className
                )}
              >
                {children}
              </ul>
            );
          },
          ol: ({ children, className, ...props }) => (
            <ol {...props} className={cn("my-3 ml-6 list-decimal space-y-1 text-foreground/90", className)}>
              {children}
            </ol>
          ),
          li: ({ children, className, ...props }) => (
            <li {...props} className={cn("leading-relaxed", className)}>
              {children}
            </li>
          ),
          h1: ({ children, ...props }) => (
            <h1
              className="text-2xl sm:text-3xl font-bold tracking-tight mt-8 mb-4 pb-2 border-b border-border/60 text-foreground"
              {...props}
            >
              {children}
            </h1>
          ),
          h2: ({ children, ...props }) => (
            <h2
              className="text-xl sm:text-2xl font-bold tracking-tight mt-6 mb-3 pb-1 border-b border-border/40 text-foreground"
              {...props}
            >
              {children}
            </h2>
          ),
          h3: ({ children, ...props }) => (
            <h3 className="text-lg sm:text-xl font-semibold tracking-tight mt-5 mb-2 text-foreground" {...props}>
              {children}
            </h3>
          ),
          h4: ({ children, ...props }) => (
            <h4 className="text-base font-semibold mt-4 mb-2 text-foreground" {...props}>
              {children}
            </h4>
          ),
          hr: (props) => <hr className="my-6 border-border/60" {...props} />,
          input: ({ type, checked, ...props }) => {
            if (type === "checkbox") {
              const data = props as Record<string, unknown>;
              const location: TaskLocation = {
                line: Number(data["data-task-line"]),
                column: Number(data["data-task-column"]),
              };
              const interactive =
                Boolean(onToggleTask) && Number.isInteger(location.line) && Number.isInteger(location.column);
              return (
                <input
                  type="checkbox"
                  checked={Boolean(checked)}
                  readOnly={!interactive}
                  disabled={!interactive}
                  onChange={interactive ? (e) => onToggleTask?.(location, e.target.checked) : undefined}
                  className={`mr-2 h-4 w-4 rounded border-border text-primary accent-primary align-middle ${
                    interactive ? "cursor-pointer" : "cursor-default"
                  }`}
                />
              );
            }
            return <input type={type} {...props} />;
          },
        }}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );
}
