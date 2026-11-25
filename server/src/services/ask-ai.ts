import { config } from '../config.js';
import type {
  AiFeatureStatus,
  AskNotesCitation,
  AskNotesResponse,
  NoteAssistAction,
  NoteAssistResponse,
  OrganizeUsage,
  RawJoplinItem,
} from '../types/index.js';
import { CacheEntry, isConflictNote, noteCache } from './note-cache.js';
import { WriteValidationError } from './note-writer.js';
import { extractLinkedResourceIds, normalizeOcrText } from './search-query.js';
import { markupLanguageOf, notePreview } from './serializer.js';

export interface AskCompletionFn {
  (
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    signal: AbortSignal,
    opts?: { maxTokens?: number; jsonMode?: boolean }
  ): Promise<{ content: string; usage?: OrganizeUsage }>;
}

export interface AudioTranscribeFn {
  (audio: Buffer, mime: string, model: string, signal: AbortSignal): Promise<{ text: string; usage?: OrganizeUsage }>;
}

export interface AskAiDeps {
  aiBaseUrl?: string | null;
  aiApiKey?: string | null;
  aiModel?: string | null;
  aiTranscribeModel?: string | null;
  aiFake?: boolean;
  aiFakeDelayMs?: number;
  completionFn?: AskCompletionFn;
  transcribeFn?: AudioTranscribeFn;
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'that',
  'this',
  'with',
  'from',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'how',
  'are',
  'was',
  'were',
  'been',
  'have',
  'has',
  'had',
  'about',
  'into',
  'all',
  'my',
  'notes',
  'note',
  'find',
  'show',
  'tell',
  'did',
  'does',
  'can',
  'could',
]);

function extractQueryTokens(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9]{2,}|[\u4e00-\u9fff]{2}/g) ?? [];
  return Array.from(new Set(matches.filter((t) => !STOP_WORDS.has(t)))).slice(0, 24);
}

function defaultCompletionClient(opts: {
  baseUrl: string;
  apiKey: string | null;
  model: string;
}): AskCompletionFn {
  const endpoint = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return async (messages, signal, callOpts) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
    const timeoutSignal = AbortSignal.timeout(45_000);
    const combinedSignal = AbortSignal.any([signal, timeoutSignal]);

    const body: Record<string, unknown> = {
      model: opts.model,
      messages,
      temperature: 0.2,
    };
    if (callOpts?.maxTokens) body.max_tokens = callOpts.maxTokens;
    if (callOpts?.jsonMode) body.response_format = { type: 'json_object' };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: combinedSignal,
    });
    if (!res.ok) {
      throw new WriteValidationError(`AI provider returned HTTP ${res.status}`, res.status === 429 ? 429 : 502);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new WriteValidationError('AI provider response did not include message content', 502);
    }
    const promptTokens = typeof data.usage?.prompt_tokens === 'number' ? data.usage.prompt_tokens : 0;
    const completionTokens = typeof data.usage?.completion_tokens === 'number' ? data.usage.completion_tokens : 0;
    const totalTokens =
      typeof data.usage?.total_tokens === 'number' ? data.usage.total_tokens : promptTokens + completionTokens;
    return { content, usage: { promptTokens, completionTokens, totalTokens } };
  };
}

function collectSubtreeIds(entry: CacheEntry, rootNotebookId: string): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const nb of entry.notebooks.values()) {
    const parent = nb.parentId || '';
    const arr = childrenOf.get(parent) ?? [];
    arr.push(nb.id);
    childrenOf.set(parent, arr);
  }
  const result = new Set<string>();
  const stack = [rootNotebookId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    stack.push(...(childrenOf.get(id) ?? []));
  }
  return result;
}

export interface AudioTranscribeResult {
  text: string;
  model: string;
  usage?: OrganizeUsage;
}

function audioFormatFromMime(mime: string): string {
  const clean = mime.split(';')[0].trim().toLowerCase();
  if (clean === 'audio/wav' || clean === 'audio/wave' || clean === 'audio/x-wav') return 'wav';
  if (clean === 'audio/mpeg' || clean === 'audio/mp3') return 'mp3';
  if (clean === 'audio/mp4' || clean === 'audio/m4a' || clean === 'audio/x-m4a') return 'm4a';
  if (clean === 'audio/ogg' || clean === 'application/ogg') return 'ogg';
  if (clean === 'audio/flac') return 'flac';
  if (clean === 'audio/aac') return 'aac';
  if (clean === 'audio/webm' || clean === 'video/webm') return 'webm';
  return 'wav';
}

function extractChoiceText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        return '';
      })
      .filter(Boolean);
    return parts.length > 0 ? parts.join('') : null;
  }
  return null;
}

function defaultTranscribeClient(opts: {
  baseUrl: string;
  apiKey: string | null;
}): AudioTranscribeFn {
  const endpoint = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return async (audio, mime, model, signal) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
    const timeoutSignal = AbortSignal.timeout(60_000);
    const combinedSignal = AbortSignal.any([signal, timeoutSignal]);
    const format = audioFormatFromMime(mime);

    const body = {
      model,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'You are a verbatim speech-to-text transcriber. Transcribe spoken audio faithfully in its original language(s) with proper punctuation. Output only the transcript text.',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Transcribe this audio recording verbatim.' },
            {
              type: 'input_audio',
              input_audio: {
                data: audio.toString('base64'),
                format,
              },
            },
          ],
        },
      ],
    };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: combinedSignal,
    });
    if (!res.ok) {
      throw new WriteValidationError(`AI transcription returned HTTP ${res.status}`, res.status === 429 ? 429 : 502);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const content = extractChoiceText(data.choices?.[0]?.message?.content);
    if (content === null) {
      throw new WriteValidationError('AI transcription response did not include message content', 502);
    }
    const promptTokens = typeof data.usage?.prompt_tokens === 'number' ? data.usage.prompt_tokens : 0;
    const completionTokens = typeof data.usage?.completion_tokens === 'number' ? data.usage.completion_tokens : 0;
    const totalTokens =
      typeof data.usage?.total_tokens === 'number' ? data.usage.total_tokens : promptTokens + completionTokens;
    return { text: content.trim(), usage: { promptTokens, completionTokens, totalTokens } };
  };
}

export class AskAiService {
  private readonly deps: AskAiDeps;

  constructor(deps: AskAiDeps = {}) {
    this.deps = deps;
  }

  private resolvedConfig() {
    const aiBaseUrl = this.deps.aiBaseUrl !== undefined ? this.deps.aiBaseUrl : config.aiBaseUrl;
    const aiApiKey = this.deps.aiApiKey !== undefined ? this.deps.aiApiKey : config.aiApiKey;
    const aiModel = this.deps.aiModel !== undefined ? this.deps.aiModel : config.aiModel;
    const aiFake = this.deps.aiFake !== undefined ? this.deps.aiFake : config.aiFake;
    const aiFakeDelayMs =
      this.deps.aiFakeDelayMs !== undefined ? this.deps.aiFakeDelayMs : config.aiFakeDelayMs;
    const hasProviderOverride =
      this.deps.aiBaseUrl !== undefined || this.deps.aiModel !== undefined;
    const aiTranscribeModel =
      this.deps.aiTranscribeModel !== undefined
        ? this.deps.aiTranscribeModel
        : hasProviderOverride
          ? aiBaseUrl && aiModel
            ? (config.aiTranscribeModel ?? 'gemini-3.8-flash')
            : null
          : config.aiTranscribeModel;

    return {
      aiBaseUrl,
      aiApiKey,
      aiModel,
      aiTranscribeModel,
      aiFake,
      aiFakeDelayMs,
    };
  }

  public getStatus(): AiFeatureStatus {
    const cfg = this.resolvedConfig();
    if (cfg.aiFake) {
      return {
        enabled: true,
        model: 'fake-assistant',
        transcribeEnabled: true,
        transcribeModel: cfg.aiTranscribeModel || 'fake-whisper',
      };
    }
    if (cfg.aiBaseUrl && cfg.aiModel) {
      const transcribeEnabled = Boolean(this.deps.transcribeFn || cfg.aiTranscribeModel);
      return {
        enabled: true,
        model: cfg.aiModel,
        transcribeEnabled,
        ...(transcribeEnabled && cfg.aiTranscribeModel ? { transcribeModel: cfg.aiTranscribeModel } : {}),
      };
    }
    if (this.deps.transcribeFn) {
      return {
        enabled: false,
        transcribeEnabled: true,
        transcribeModel: cfg.aiTranscribeModel || 'custom-transcribe',
      };
    }
    return { enabled: false, transcribeEnabled: false };
  }

  public async transcribeAudio(
    audio: Buffer,
    mime: string,
    signal: AbortSignal
  ): Promise<AudioTranscribeResult> {
    if (!Buffer.isBuffer(audio) || audio.length === 0) {
      throw new WriteValidationError('Audio data is required', 400);
    }
    if (audio.length > 25 * 1024 * 1024) {
      throw new WriteValidationError('Audio recording exceeds 25 MB limit', 413);
    }
    const status = this.getStatus();
    if (!status.transcribeEnabled) {
      throw new WriteValidationError(
        'Voice transcription requires AI_BASE_URL, AI_MODEL and AI_TRANSCRIBE_MODEL (or AI_FAKE=true)',
        503
      );
    }

    const cfg = this.resolvedConfig();
    const model = status.transcribeModel || 'gemini-3.8-flash';
    if (this.deps.transcribeFn) {
      const out = await this.deps.transcribeFn(audio, mime, model, signal);
      return { text: out.text.trim(), model, ...(out.usage ? { usage: out.usage } : {}) };
    }
    if (cfg.aiFake) {
      if (cfg.aiFakeDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, cfg.aiFakeDelayMs));
      }
      return {
        text: 'Voice memo transcript (fake): discussed action items and follow-up tasks.',
        model,
        usage: { promptTokens: 25, completionTokens: 15, totalTokens: 40 },
      };
    }

    const client = defaultTranscribeClient({
      baseUrl: cfg.aiBaseUrl!,
      apiKey: cfg.aiApiKey,
    });
    const out = await client(audio, mime, model, signal);
    return { text: out.text.trim(), model, ...(out.usage ? { usage: out.usage } : {}) };
  }

  private assertEnabled(): void {
    if (!this.getStatus().enabled) {
      throw new WriteValidationError('AI features require AI_BASE_URL and AI_MODEL (or AI_FAKE=true)', 503);
    }
  }

  private async complete(
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    signal: AbortSignal,
    opts?: { maxTokens?: number; jsonMode?: boolean }
  ): Promise<{ content: string; usage?: OrganizeUsage }> {
    const cfg = this.resolvedConfig();
    if (this.deps.completionFn) {
      return this.deps.completionFn(messages, signal, opts);
    }
    if (cfg.aiFake) {
      if (cfg.aiFakeDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, cfg.aiFakeDelayMs));
      }
      return { content: '__FAKE__', usage: { promptTokens: 40, completionTokens: 20, totalTokens: 60 } };
    }
    const client = defaultCompletionClient({
      baseUrl: cfg.aiBaseUrl!,
      apiKey: cfg.aiApiKey,
      model: cfg.aiModel!,
    });
    return client(messages, signal, opts);
  }

  public async askNotes(
    sessionId: string,
    input: { question: string; scopeNotebookId?: string; scopeTagId?: string },
    signal: AbortSignal
  ): Promise<AskNotesResponse> {
    this.assertEnabled();
    const question = typeof input.question === 'string' ? input.question.trim() : '';
    if (!question || question.length > 1000) {
      throw new WriteValidationError('question must be 1 to 1000 characters', 400);
    }

    const entry = await noteCache.getEntry(sessionId);
    const deletedNotebookIds = new Set(
      Array.from(entry.notebooks.values())
        .filter((nb) => nb.deletedTime && nb.deletedTime > 0)
        .map((nb) => nb.id)
    );
    const allowedNotebooks = input.scopeNotebookId ? collectSubtreeIds(entry, input.scopeNotebookId) : null;
    const allowedByTag = input.scopeTagId
      ? new Set(entry.noteTags.filter((l) => l.tagId === input.scopeTagId).map((l) => l.noteId))
      : null;

    const tokens = extractQueryTokens(question);
    const qLower = question.toLowerCase();

    const scored: Array<{
      note: RawJoplinItem;
      score: number;
      excerpt: string;
      notebookTitle: string;
    }> = [];

    for (const note of entry.notes.values()) {
      if (
        isConflictNote(note) ||
        (note.deletedTime && note.deletedTime > 0) ||
        (note.parentId && deletedNotebookIds.has(note.parentId)) ||
        note.properties.encryption_applied === '1'
      ) {
        continue;
      }
      if (allowedNotebooks && !allowedNotebooks.has(note.parentId || '')) continue;
      if (allowedByTag && !allowedByTag.has(note.id)) continue;

      const titleLower = (note.title || '').toLowerCase();
      const plain = notePreview(note.body || '', markupLanguageOf(note.properties), 1600);
      const plainLower = plain.toLowerCase();
      const ocrParts: string[] = [];
      if (note.body && note.body.includes(':/')) {
        for (const resId of extractLinkedResourceIds(note.body)) {
          const ocr = entry.resources.get(resId)?.ocrText;
          if (ocr) ocrParts.push(normalizeOcrText(ocr));
        }
      }
      const ocrText = ocrParts.join(' ');
      const ocrLower = ocrText.toLowerCase();

      let score = 0;
      if (tokens.length === 0) {
        score = note.updatedTime / 1e13;
      } else {
        if (titleLower.includes(qLower)) score += 20;
        if (plainLower.includes(qLower)) score += 10;
        for (const tok of tokens) {
          if (titleLower.includes(tok)) score += 6;
          if (plainLower.includes(tok)) score += 3;
          if (ocrLower.includes(tok)) score += 2;
        }
      }

      if (score > 0 || tokens.length === 0) {
        const nb = note.parentId ? entry.notebooks.get(note.parentId) : null;
        const nbTitle = nb?.properties.encryption_applied === '1' ? 'Encrypted notebook' : nb?.title || 'Inbox';
        const excerpt = [plain, ocrText ? `[Attachment OCR]: ${ocrText.slice(0, 600)}` : '']
          .filter(Boolean)
          .join('\n')
          .slice(0, 1200);
        scored.push({ note, score, excerpt, notebookTitle: nbTitle });
      }
    }

    scored.sort((a, b) => b.score - a.score || b.note.updatedTime - a.note.updatedTime);
    const top = scored.slice(0, 8);
    const citations: AskNotesCitation[] = top.map((item) => ({
      id: item.note.id,
      title: item.note.title || 'Untitled Note',
      notebookTitle: item.notebookTitle,
      updatedTime: item.note.updatedTime,
      excerpt: item.excerpt.slice(0, 200),
    }));

    if (top.length === 0) {
      return {
        answer: 'No matching notes were found in the selected scope to answer that question.',
        citations: [],
      };
    }

    const contextBlock = top
      .map(
        (item, idx) =>
          `[${idx + 1}] Title: ${item.note.title || 'Untitled Note'}\nLink: [:${item.note.id}](:/${item.note.id})\nNotebook: ${item.notebookTitle}\nContent:\n${item.excerpt}`
      )
      .join('\n\n---\n\n');

    const { content, usage } = await this.complete(
      [
        {
          role: 'system',
          content:
            'You are a grounded personal notes assistant. Answer the user using ONLY the provided notes. ' +
            'Cite every supporting note inline as Markdown links using exact note titles and IDs: `[Note Title](:/noteId)`. ' +
            'If the notes do not contain the answer, say so clearly.',
        },
        {
          role: 'user',
          content: `Question: ${question}\n\nRelevant notes:\n${contextBlock}`,
        },
      ],
      signal,
      { maxTokens: 900 }
    );

    if (content === '__FAKE__') {
      const refs = citations.slice(0, 3).map((c) => `- [${c.title}](:/${c.id}) — ${c.excerpt.slice(0, 90)}`);
      return {
        answer: `Based on your notes for "${question}":\n\n${refs.join('\n')}`,
        citations,
        usage,
      };
    }

    return { answer: content.trim(), citations, usage };
  }

  public async noteAssist(
    sessionId: string,
    input: { noteId: string; action: NoteAssistAction },
    signal: AbortSignal
  ): Promise<NoteAssistResponse> {
    this.assertEnabled();
    const validActions: NoteAssistAction[] = ['summarize', 'action-items', 'suggest-tags', 'cleanup'];
    if (!validActions.includes(input.action)) {
      throw new WriteValidationError('Invalid assist action', 400);
    }

    const detail = await noteCache.getNote(sessionId, input.noteId);
    if (!detail) {
      throw new WriteValidationError(`Note not found: ${input.noteId}`, 404);
    }
    if (detail.encrypted) {
      throw new WriteValidationError('Encrypted notes cannot be processed by AI assist', 422);
    }
    const ocr = await noteCache.getNoteAttachmentText(sessionId, input.noteId, { maxChars: 3000 });
    const noteBody = notePreview(detail.body, detail.markupLanguage, 5000);

    const instructions: Record<NoteAssistAction, string> = {
      summarize: 'Write a crisp 3-5 bullet executive summary of this note and its OCR text.',
      'action-items': 'Extract concrete action items as a Markdown checklist (`- [ ] ...`).',
      'suggest-tags':
        'Return a JSON object `{ "tags": ["tag-one", "tag-two"], "result": "explanation" }` with 2 to 5 concise lowercase-hyphenated tags.',
      cleanup: 'Rewrite/clean up the note content into well-structured, concise Markdown preserving all facts.',
    };

    const { content, usage } = await this.complete(
      [
        { role: 'system', content: instructions[input.action] },
        {
          role: 'user',
          content: `Title: ${detail.title || 'Untitled Note'}\nNotebook: ${detail.notebookTitle}\nBody:\n${detail.body.slice(0, 6000) || noteBody}${ocr ? `\n\nAttachment OCR:\n${ocr}` : ''}`,
        },
      ],
      signal,
      { jsonMode: input.action === 'suggest-tags', maxTokens: 800 }
    );

    if (content === '__FAKE__') {
      if (input.action === 'suggest-tags') {
        const tokens = extractQueryTokens(`${detail.title} ${noteBody}`).slice(0, 3);
        const tags = tokens.length > 0 ? tokens : ['notes', 'review'];
        return { result: `Suggested tags: ${tags.map((t) => `#${t}`).join(', ')}`, tags, usage };
      }
      if (input.action === 'action-items') {
        return {
          result: `- [ ] Review ${detail.title || 'note'} details\n- [ ] Follow up on next steps`,
          usage,
        };
      }
      if (input.action === 'summarize') {
        return {
          result: `- **Topic:** ${detail.title || 'Untitled Note'}\n- **Summary:** ${noteBody.slice(0, 160) || 'Empty note.'}`,
          usage,
        };
      }
      return {
        result: `# ${detail.title || 'Untitled Note'}\n\n${detail.body.trim() || noteBody}`,
        usage,
      };
    }

    if (input.action === 'suggest-tags') {
      try {
        const parsed = JSON.parse(content) as { tags?: unknown; result?: unknown };
        const tags = Array.isArray(parsed.tags)
          ? parsed.tags
              .filter((t): t is string => typeof t === 'string')
              .map((t) => t.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-'))
              .filter(Boolean)
              .slice(0, 6)
          : [];
        return {
          result: typeof parsed.result === 'string' ? parsed.result : `Suggested tags: ${tags.join(', ')}`,
          tags,
          usage,
        };
      } catch {
        return { result: content.trim(), usage };
      }
    }

    return { result: content.trim(), usage };
  }
}

export const askAiService = new AskAiService();
