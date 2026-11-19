import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { FileText, Loader2, Send, Sparkles } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { useNotebooks } from "@/hooks/use-notebooks";
import { useTags } from "@/hooks/use-tags";
import { useAskNotes } from "@/hooks/use-workspace";
import { flattenNotebooks } from "@/lib/notebooks";
import { formatRelativeTime } from "@/lib/format";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import type { AskNotesResponse } from "@/lib/types";

interface AskNotesDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultNotebookId?: string | null;
  defaultTagId?: string | null;
}

const EXAMPLE_QUESTIONS = [
  "What action items do I have across my notes?",
  "Summarize my recent project notes",
  "Which invoices or receipts have been recorded?",
];

export function AskNotesDrawer({
  open,
  onOpenChange,
  defaultNotebookId = null,
  defaultTagId = null,
}: AskNotesDrawerProps) {
  const navigate = useNavigate();
  const { data: notebooks } = useNotebooks();
  const { data: tags } = useTags();
  const askMutation = useAskNotes();

  const [question, setQuestion] = useState("");
  const [scopeNotebookId, setScopeNotebookId] = useState<string>(defaultNotebookId ?? "");
  const [scopeTagId, setScopeTagId] = useState<string>(defaultTagId ?? "");
  const [result, setResult] = useState<AskNotesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const flatNotebooks = flattenNotebooks(notebooks);

  const handleSubmit = async (qOverride?: string) => {
    const q = (qOverride ?? question).trim();
    if (!q) return;
    if (qOverride) setQuestion(qOverride);
    setError(null);
    try {
      const response = await askMutation.mutateAsync({
        question: q,
        ...(scopeNotebookId ? { scopeNotebookId } : {}),
        ...(scopeTagId ? { scopeTagId } : {}),
      });
      setResult(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not answer your question.");
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg flex flex-col p-0">
        <SheetHeader className="px-6 py-4 border-b border-border shrink-0 text-left">
          <SheetTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" />
            Ask My Notes
          </SheetTitle>
          <SheetDescription className="text-xs">
            Ask a question grounded in your non-encrypted notes with clickable citations.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
          {/* Scope filters */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="text-xs space-y-1">
              <span className="text-muted-foreground font-medium block">Notebook scope</span>
              <select
                value={scopeNotebookId}
                onChange={(e) => setScopeNotebookId(e.target.value)}
                aria-label="Filter AI scope by notebook"
                className="w-full h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
              >
                <option value="">All notebooks</option>
                {flatNotebooks
                  .filter((nb) => !nb.encrypted)
                  .map((nb) => (
                    <option key={nb.id} value={nb.id}>
                      {"— ".repeat(nb.depth)}
                      {nb.title}
                    </option>
                  ))}
              </select>
            </label>

            <label className="text-xs space-y-1">
              <span className="text-muted-foreground font-medium block">Tag scope</span>
              <select
                value={scopeTagId}
                onChange={(e) => setScopeTagId(e.target.value)}
                aria-label="Filter AI scope by tag"
                className="w-full h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
              >
                <option value="">All tags</option>
                {(tags ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    #{t.title}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* Question composer */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleSubmit();
            }}
            className="space-y-2"
          >
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                  e.preventDefault();
                  void handleSubmit();
                }
              }}
              rows={3}
              placeholder="Ask anything about your notes..."
              aria-label="Question for Ask My Notes"
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-primary/50"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-muted-foreground">Ctrl+Enter to ask</span>
              <Button type="submit" size="sm" disabled={askMutation.isPending || !question.trim()} className="gap-1.5">
                {askMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                Ask
              </Button>
            </div>
          </form>

          {!result && !askMutation.isPending && (
            <div className="space-y-2 pt-2">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Try asking</p>
              <div className="flex flex-wrap gap-1.5">
                {EXAMPLE_QUESTIONS.map((sample) => (
                  <button
                    key={sample}
                    type="button"
                    onClick={() => void handleSubmit(sample)}
                    className="rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-left text-xs text-foreground hover:bg-muted transition-colors"
                  >
                    {sample}
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
              {error}
            </div>
          )}

          {result && (
            <div className="space-y-4 pt-2 border-t border-border/60">
              <div className="rounded-xl border border-border bg-card/50 p-4">
                <MarkdownRenderer content={result.answer} className="text-sm" />
                {result.usage && result.usage.totalTokens > 0 && (
                  <p className="mt-3 text-[11px] font-mono text-muted-foreground">
                    {result.usage.totalTokens.toLocaleString()} tokens used
                  </p>
                )}
              </div>

              {result.citations.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-foreground">
                    Sources ({result.citations.length})
                  </p>
                  <div className="space-y-2">
                    {result.citations.map((citation) => (
                      <button
                        key={citation.id}
                        type="button"
                        onClick={() => {
                          onOpenChange(false);
                          navigate(`/notes/${citation.id}`);
                        }}
                        className="w-full text-left rounded-xl border border-border bg-background hover:bg-muted/50 p-3 transition-colors space-y-1"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-1.5 font-medium text-xs text-foreground truncate">
                            <FileText className="h-3.5 w-3.5 text-primary shrink-0" />
                            <span className="truncate">{citation.title || "Untitled Note"}</span>
                          </span>
                          <span className="text-[11px] text-muted-foreground shrink-0">
                            {formatRelativeTime(citation.updatedTime)}
                          </span>
                        </div>
                        <p className="text-[11px] text-muted-foreground line-clamp-2">{citation.excerpt}</p>
                        {citation.notebookTitle && (
                          <p className="text-[10px] font-mono text-muted-foreground">{citation.notebookTitle}</p>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
