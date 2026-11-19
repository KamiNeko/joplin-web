import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type { AppConfig } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { joplinApi } from '../services/joplin-api.js';
import { noteCache } from '../services/note-cache.js';
import { assertValidId, noteWriter, WriteValidationError } from '../services/note-writer.js';
import {
  extractArticleFromHtml,
  fetchAndClipUrl,
  parseEmlMessage,
} from '../services/web-clipper.js';
import type { Notebook } from '../types/index.js';

function firstWritableNotebookId(notebooks: Notebook[]): string | null {
  for (const nb of notebooks) {
    if (!nb.encrypted) return nb.id;
    const child = firstWritableNotebookId(nb.children);
    if (child) return child;
  }
  return null;
}

function flattenNotebooks(notebooks: Notebook[]): Notebook[] {
  const out: Notebook[] = [];
  const walk = (list: Notebook[]) => {
    for (const nb of list) {
      out.push(nb);
      if (nb.children.length > 0) walk(nb.children);
    }
  };
  walk(notebooks);
  return out;
}

export function findInboxOrDefaultNotebookId(notebooks: Notebook[], configuredId: string | null): string | null {
  const flat = flattenNotebooks(notebooks).filter((n) => !n.encrypted);
  if (configuredId && flat.some((n) => n.id === configuredId)) return configuredId;
  const inbox =
    flat.find((n) => n.title.trim().toLowerCase() === 'inbox') ??
    flat.find((n) => n.title.trim().toLowerCase() === 'pending to sort');
  return inbox?.id ?? flat[0]?.id ?? null;
}

function verifySecret(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createClipRouter(deps: { fetchClip?: typeof fetchAndClipUrl } = {}): Router {
  const router = Router();
  const clipUrl = deps.fetchClip ?? fetchAndClipUrl;

  /**
   * POST /api/clip
   * Body: { url, parentId?, tags?, includeSourceBanner? }
   */
  router.post('/clip', requireAuth, async (req, res) => {
    const { url, parentId, tags, includeSourceBanner } = (req.body ?? {}) as {
      url?: unknown;
      parentId?: unknown;
      tags?: unknown;
      includeSourceBanner?: unknown;
    };
    if (typeof url !== 'string' || !url.trim()) {
      res.status(400).json({ error: 'url is required' });
      return;
    }

    let targetNotebookId =
      typeof parentId === 'string' && parentId.trim() ? assertValidId(parentId.trim(), 'notebook id') : '';
    if (!targetNotebookId) {
      const notebooks = await noteCache.getNotebooks(req.sessionId!);
      const fallback = findInboxOrDefaultNotebookId(notebooks, null);
      if (!fallback) {
        throw new WriteValidationError('Create a non-encrypted notebook before clipping pages', 400);
      }
      targetNotebookId = fallback;
    }

    const article = await clipUrl(url);
    const metaLines: string[] = [];
    if (includeSourceBanner !== false) {
      const bits = [`Clipped from ${article.url}`];
      if (article.byline) bits.push(`by ${article.byline}`);
      metaLines.push(`> ${bits.join(' · ')}`);
    }
    const fullBody = [...metaLines, article.markdown].filter(Boolean).join('\n\n');

    let note = await noteWriter.createNote(req.sessionId!, {
      title: article.title,
      body: fullBody,
      parentId: targetNotebookId,
      sourceUrl: article.url,
      author: article.byline,
    });

    if (Array.isArray(tags)) {
      for (const rawTag of tags.slice(0, 10)) {
        if (typeof rawTag === 'string' && rawTag.trim()) {
          note = await noteWriter.addTagToNote(req.sessionId!, note.id, rawTag.trim());
        }
      }
    }

    res.status(201).json({
      note,
      extractedTitle: article.title,
      siteName: article.siteName,
    });
  });

  /**
   * POST /api/integrations/email
   * Authenticated email import from raw .eml content or structured fields.
   */
  router.post('/integrations/email', requireAuth, async (req, res) => {
    const note = await createEmailNote(req.sessionId!, req.body, null, {
      parentIdHeader: headerString(req.headers['x-joplin-notebook-id']),
      tagsHeader: headerString(req.headers['x-joplin-tags']),
    });
    res.status(201).json({ note });
  });

  return router;
}

function headerString(val: string | string[] | undefined): string | undefined {
  if (typeof val === 'string') return val.trim() || undefined;
  if (Array.isArray(val) && typeof val[0] === 'string') return val[0].trim() || undefined;
  return undefined;
}

async function createEmailNote(
  sessionId: string,
  payload: unknown,
  defaultNotebookId: string | null = null,
  headers: { parentIdHeader?: string; tagsHeader?: string } = {}
) {
  let subject: unknown;
  let from: unknown;
  let text: unknown;
  let html: unknown;
  let parentId: unknown;
  let tags: unknown;
  let raw: string | Buffer | undefined;

  if (Buffer.isBuffer(payload) || typeof payload === 'string') {
    raw = payload;
  } else if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    ({ raw, subject, from, text, html, parentId, tags } = payload as {
      raw?: string | Buffer;
      subject?: unknown;
      from?: unknown;
      text?: unknown;
      html?: unknown;
      parentId?: unknown;
      tags?: unknown;
    });
  } else {
    throw new WriteValidationError('Request body must be a JSON object or raw RFC-822 email message', 400);
  }

  let parsed = {
    subject: typeof subject === 'string' && subject.trim() ? subject.trim() : 'Email Note',
    from: typeof from === 'string' ? from.trim() : '',
    date: '',
    markdownBody: '',
  };

  if (Buffer.isBuffer(raw)) {
    if (raw.toString('utf8').trim().length === 0) {
      throw new WriteValidationError('Email body must not be empty', 400);
    }
    parsed = parseEmlMessage(raw);
  } else if (typeof raw === 'string' && raw.trim()) {
    parsed = parseEmlMessage(raw);
  } else {
    const plain = typeof text === 'string' ? text.trim() : '';
    const htmlStr = typeof html === 'string' ? html.trim() : '';
    parsed.markdownBody = plain || (htmlStr ? extractArticleFromHtml(htmlStr, 'https://email.local/').markdown : '');
  }

  if (!parsed.subject && !parsed.markdownBody) {
    throw new WriteValidationError('Email must include raw .eml or subject/text/html content', 400);
  }

  const rawParentId = typeof parentId === 'string' && parentId.trim() ? parentId.trim() : headers.parentIdHeader;
  let targetNotebookId = rawParentId ? assertValidId(rawParentId, 'notebook id') : '';
  if (!targetNotebookId) {
    const notebooks = await noteCache.getNotebooks(sessionId);
    const fallback = findInboxOrDefaultNotebookId(notebooks, defaultNotebookId);
    if (!fallback) {
      throw new WriteValidationError('No writable notebook found for email ingest', 400);
    }
    targetNotebookId = fallback;
  }

  const headerQuote: string[] = [];
  if (parsed.from) headerQuote.push(`**From:** ${parsed.from}`);
  if (parsed.date) headerQuote.push(`**Date:** ${parsed.date}`);
  const fullBody = [headerQuote.length > 0 ? headerQuote.map((l) => `> ${l}`).join('\n') : '', parsed.markdownBody]
    .filter(Boolean)
    .join('\n\n');

  let note = await noteWriter.createNote(sessionId, {
    title: parsed.subject,
    body: fullBody,
    parentId: targetNotebookId,
    author: parsed.from || undefined,
  });

  const tagList = Array.isArray(tags)
    ? tags.filter((t): t is string => typeof t === 'string' && Boolean(t.trim())).slice(0, 10)
    : headers.tagsHeader
      ? headers.tagsHeader
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 10)
      : ['email'];
  for (const t of tagList) {
    note = await noteWriter.addTagToNote(sessionId, note.id, t);
  }

  return note;
}

export function createEmailWebhookRouter(config: AppConfig): Router {
  const router = Router();
  let serviceSession: { sessionId: string; obtainedAt: number } | null = null;

  router.post('/email', async (req, res) => {
    if (
      !config.emailIngestWebhookSecret ||
      !config.emailIngestJoplinEmail ||
      !config.emailIngestJoplinPassword
    ) {
      res.status(404).json({ error: 'Email webhook ingest is not configured on this server' });
      return;
    }

    const headerSecret = typeof req.headers['x-webhook-secret'] === 'string' ? req.headers['x-webhook-secret'].trim() : '';
    const bearer =
      typeof req.headers.authorization === 'string' && req.headers.authorization.toLowerCase().startsWith('bearer ')
        ? req.headers.authorization.slice(7).trim()
        : '';
    if (!verifySecret(headerSecret || bearer, config.emailIngestWebhookSecret)) {
      res.status(401).json({ error: 'Invalid webhook secret' });
      return;
    }

    const authenticate = async () => {
      const login = await joplinApi.createSession(config.emailIngestJoplinEmail!, config.emailIngestJoplinPassword!);
      noteCache.bindSession(login.sessionId, login.userId);
      serviceSession = { sessionId: login.sessionId, obtainedAt: Date.now() };
      return login.sessionId;
    };

    const now = Date.now();
    let sessionId =
      serviceSession && now - serviceSession.obtainedAt < config.authCacheTtlMs
        ? serviceSession.sessionId
        : await authenticate();

    const headerOpts = {
      parentIdHeader: headerString(req.headers['x-joplin-notebook-id']),
      tagsHeader: headerString(req.headers['x-joplin-tags']),
    };

    try {
      const note = await createEmailNote(sessionId, req.body, config.emailIngestNotebookId, headerOpts);
      res.status(201).json({ note });
    } catch (err) {
      if ((err as { status?: number })?.status === 401) {
        sessionId = await authenticate();
        const note = await createEmailNote(sessionId, req.body, config.emailIngestNotebookId, headerOpts);
        res.status(201).json({ note });
        return;
      }
      throw err;
    }
  });

  return router;
}

// Re-export helper so TypeScript knows it stays clean if needed
export { firstWritableNotebookId };
