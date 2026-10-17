import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy, ExternalLink } from "lucide-react";
import { getResourceUrl } from "@/lib/api";
import { useNavigate } from "react-router-dom";

interface MarkdownRendererProps {
  content: string;
  className?: string;
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

  // Replace Markdown image syntax: ![alt](:/id) -> ![alt](/api/resources/id)
  let transformed = raw.replace(
    /!\[(.*?)\]\(:([a-zA-Z0-9_-]+)\)/g,
    (_, alt, id) => `![${alt}](${getResourceUrl(id)})`
  );

  // Replace HTML image src: <img src=":/id" ...> -> <img src="/api/resources/id" ...>
  transformed = transformed.replace(
    /<img([^>]+)src=["']:\/?([a-zA-Z0-9_-]+)["']([^>]*)>/gi,
    (_, before, id, after) => `<img${before}src="${getResourceUrl(id)}"${after}>`
  );

  return transformed;
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
        className="rounded bg-muted/70 px-1.5 py-0.5 font-mono text-xs text-primary font-medium border border-border/50"
        {...props}
      >
        {children}
      </code>
    );
  }

  return (
    <div className="relative group my-4 rounded-xl border border-border/60 bg-slate-950 dark:bg-[#070b14] overflow-hidden shadow-md">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border/40 bg-muted/20 text-xs text-muted-foreground font-mono">
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
              <Check className="h-3.5 w-3.5 text-emerald-400" />
              <span className="text-emerald-400">Copied!</span>
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <div className="p-4 overflow-x-auto text-sm font-mono leading-relaxed text-slate-100">
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
export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  const navigate = useNavigate();
  const processedContent = preprocessJoplinMarkdown(content);

  return (
    <div className={`prose-content text-foreground leading-relaxed ${className ?? ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          rehypeRaw,
          [rehypeSanitize, sanitizeSchema],
          rehypeHighlight,
        ]}
        components={{
          code: CodeBlock,
          a: ({ href, children, ...props }) => {
            if (!href) return <a {...props}>{children}</a>;

            // Joplin internal note link handling (e.g., :/12345abcde)
            if (href.startsWith(":/")) {
              const noteId = href.replace(/^:\/?/, "");
              return (
                <button
                  type="button"
                  onClick={() => navigate(`/notes/${noteId}`)}
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
          img: ({ src, alt, ...props }) => {
            let actualSrc = src || "";
            if (actualSrc.startsWith(":/")) {
              actualSrc = getResourceUrl(actualSrc);
            }
            return (
              <span className="block my-4">
                <img
                  src={actualSrc}
                  alt={alt || "Note image"}
                  className="rounded-lg border border-border/40 max-w-full h-auto object-contain shadow-sm bg-muted/20"
                  loading="lazy"
                  {...props}
                />
                {alt && (
                  <span className="block text-center text-xs text-muted-foreground mt-1.5 italic">
                    {alt}
                  </span>
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
              className="my-4 border-l-4 border-primary/70 bg-muted/30 py-2.5 px-4 rounded-r-lg italic text-foreground/90"
              {...props}
            >
              {children}
            </blockquote>
          ),
          ul: ({ children, ...props }) => (
            <ul className="my-3 ml-6 list-disc space-y-1 text-foreground/90" {...props}>
              {children}
            </ul>
          ),
          ol: ({ children, ...props }) => (
            <ol className="my-3 ml-6 list-decimal space-y-1 text-foreground/90" {...props}>
              {children}
            </ol>
          ),
          li: ({ children, ...props }) => (
            <li className="leading-relaxed" {...props}>
              {children}
            </li>
          ),
          h1: ({ children, ...props }) => (
            <h1
              className="text-2xl sm:text-3xl font-extrabold tracking-tight mt-8 mb-4 pb-2 border-b border-border/60 text-foreground"
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
              return (
                <input
                  type="checkbox"
                  checked={checked}
                  readOnly
                  disabled
                  className="mr-2 h-4 w-4 rounded border-border text-primary accent-primary cursor-default align-middle"
                  {...props}
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
