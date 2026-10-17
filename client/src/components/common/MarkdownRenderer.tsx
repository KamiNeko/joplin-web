import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy, ExternalLink } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, downloadResource, getNote, getResourceIdFromUrl, getResourceUrl } from "@/lib/api";
import { ResourceImage } from "./ResourceImage";
import { cn } from "@/lib/utils";
import { useNavigate } from "react-router-dom";

interface MarkdownRendererProps {
  content: string;
  className?: string;
  /** Makes task-list checkboxes clickable; index is the task's position in document order */
  onToggleTask?: (index: number, checked: boolean) => void;
}

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/**
 * Rehype plugin that numbers GFM task-list checkboxes in document order (data-task-index),
 * so a click can be mapped back to the matching "[ ]" in the Markdown source.
 */
function rehypeTaskIndex() {
  return (tree: HastNode) => {
    let index = 0;
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
      if (node.type === "element" && node.tagName === "li") {
        const classes = node.properties?.className;
        if (Array.isArray(classes) && classes.includes("task-list-item")) {
          const checkbox = findCheckbox(node);
          if (checkbox?.properties) checkbox.properties.dataTaskIndex = index++;
        }
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

// Custom sanitize schema allowing highlight classes and common markdown elements
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code || []), ["className"]],
    span: [...(defaultSchema.attributes?.span || []), ["className"]],
    div: [...(defaultSchema.attributes?.div || []), ["className"]],
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
  let transformed = raw.replace(
    /!\[([^\]]*)\]\(\s*:\/?([0-9a-fA-F]{32})(\s+"[^"]*")?\s*\)/g,
    (_, alt, id, title = "") => `![${alt}](${getResourceUrl(id)}${title})`
  );

  // Replace HTML image src: <img src=":/id" ...> -> <img src="/api/resources/id" ...>
  transformed = transformed.replace(
    /<img([^>]+)src=["']:\/?([a-zA-Z0-9_-]+)["']([^>]*)>/gi,
    (_, before, id, after) => `<img${before}src="${getResourceUrl(id)}"${after}>`
  );

  // Replace links to notes/attachments: [text](:/id) and <a href=":/id"> -> /joplin-item/id.
  // A ":/" href would be dropped by the sanitizer as an unknown protocol.
  transformed = transformed.replace(
    /(^|[^!])\[([^\]]*)\]\(\s*:\/?([0-9a-fA-F]{32})(\s+"[^"]*")?\s*\)/g,
    (_, before, text, id, title = "") => `${before}[${text}](${JOPLIN_ITEM_PATH}${id.toLowerCase()}${title})`
  );
  transformed = transformed.replace(
    /<a([^>]+)href=["']:\/?([0-9a-fA-F]{32})["']/gi,
    (_, before, id) => `<a${before}href="${JOPLIN_ITEM_PATH}${id.toLowerCase()}"`
  );

  return transformed;
}

const JOPLIN_ITEM_PATH = "/joplin-item/";

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
      <div className="flex items-center justify-between px-4 py-2 border-b border-border/40 bg-foreground/[0.03] text-xs text-muted-foreground font-mono">
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
              <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              <span className="text-emerald-600 dark:text-emerald-400">Copied!</span>
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
export function MarkdownRenderer({ content, className, onToggleTask }: MarkdownRendererProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // ":/id" can point to a note or an attachment; only the server knows which
  const openJoplinItem = async (id: string, label: string) => {
    try {
      await queryClient.fetchQuery({ queryKey: ["note", id], queryFn: () => getNote(id), staleTime: 15 * 1000 });
      navigate(`/notes/${id}`);
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
  const processedContent = preprocessJoplinMarkdown(content);

  return (
    <div className={`prose-content text-foreground leading-relaxed ${className ?? ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          rehypeRaw,
          [rehypeSanitize, sanitizeSchema],
          rehypeTaskIndex,
          rehypeHighlight,
        ]}
        components={{
          code: CodeBlock,
          a: ({ href, children, ...props }) => {
            if (!href) return <a {...props}>{children}</a>;

            // Links to Joplin notes or attachments (":/id", rewritten in preprocessing)
            if (href.startsWith(JOPLIN_ITEM_PATH)) {
              const itemId = href.slice(JOPLIN_ITEM_PATH.length);
              return (
                <button
                  type="button"
                  onClick={() => void openJoplinItem(itemId, textContent(children))}
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
              "rounded-lg border border-border/40 max-w-full h-auto object-contain shadow-sm bg-muted/20";
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
            <div className="my-6 w-full overflow-x-auto rounded-lg border border-border/50 shadow-sm">
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
                  isTaskList && "ml-0 list-none [li_&]:ml-6 [li_&]:my-1",
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
              const taskIndex = Number((props as Record<string, unknown>)["data-task-index"]);
              const interactive = Boolean(onToggleTask) && Number.isInteger(taskIndex);
              return (
                <input
                  type="checkbox"
                  checked={Boolean(checked)}
                  readOnly={!interactive}
                  disabled={!interactive}
                  onChange={interactive ? (e) => onToggleTask?.(taskIndex, e.target.checked) : undefined}
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
