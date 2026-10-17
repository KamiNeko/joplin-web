import express, { Request, Response } from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { randomBytes } from 'crypto';

/**
 * In-memory stand-in for Joplin Server's sync-target API.
 *
 * Implements exactly the endpoints Joplin Web uses (see src/services/joplin-api.ts):
 *   GET    /api/ping
 *   POST   /api/sessions                              { email, password } -> { id, user_id }
 *   GET    /api/items/root:/:/children                paginated { items, has_more, cursor }
 *   GET    /api/items/root:/<name>:/content           raw item text, resource binary or info.json
 *   PUT    /api/items/root:/<name>:/content           multipart upload (field "file")
 *   DELETE /api/items/root:/<name>:
 *
 * Used by the integration tests and the local demo (npm run demo). Never point it at real data.
 */

export interface MockItem {
  content: Buffer;
  contentType: string;
  updatedTime: number;
}

export interface MockJoplinServerOptions {
  email: string;
  password: string;
  /** Initial items keyed by item name ("<id>.md" or ".resource/<id>") */
  items?: Map<string, MockItem>;
  /** Page size for the children listing, small values exercise cursor pagination */
  pageSize?: number;
}

export interface MockJoplinServer {
  url: string;
  items: Map<string, MockItem>;
  close: () => Promise<void>;
}

/**
 * Builds the sync target's `info.json` the way Joplin desktop (sync version 3) writes it.
 * Store it under the name "info.json" to simulate an account with or without E2EE.
 */
export function syncTargetInfoItem(e2ee: boolean, updatedTime = Date.now()): MockItem {
  const info = {
    version: 3,
    e2ee: { value: e2ee, updatedTime },
    activeMasterKeyId: { value: e2ee ? '0123456789abcdef0123456789abcdef' : '', updatedTime },
    masterKeys: [],
    ppk: { value: null, updatedTime: 0 },
    appMinVersion: '3.0.0',
  };
  return { content: Buffer.from(JSON.stringify(info)), contentType: 'application/json', updatedTime };
}

const ITEM_PATH =/^\/root:\/(.*?):(\/content|\/children)?$/;

function parseMultipartFile(body: Buffer, contentType: string): Buffer | null {
  const boundaryMatch = /boundary=(.+)$/i.exec(contentType);
  if (!boundaryMatch) return null;
  const boundary = Buffer.from(`--${boundaryMatch[1]}`);
  let start = body.indexOf(boundary);
  while (start >= 0) {
    const next = body.indexOf(boundary, start + boundary.length);
    if (next < 0) break;
    const part = body.subarray(start + boundary.length, next);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd >= 0) {
      const headers = part.subarray(0, headerEnd).toString('utf8');
      if (/name="file"/i.test(headers)) {
        // Part content ends with the CRLF that precedes the next boundary
        return part.subarray(headerEnd + 4, part.length - 2);
      }
    }
    start = next;
  }
  return null;
}

export async function startMockJoplinServer(
  options: MockJoplinServerOptions,
  port = 0
): Promise<MockJoplinServer> {
  const items = options.items ?? new Map<string, MockItem>();
  const pageSize = options.pageSize ?? 100;
  const sessions = new Set<string>();
  let clock = Date.now();
  const tick = () => (clock = Math.max(clock + 1, Date.now()));

  const app = express();

  app.get('/api/ping', (_req, res) => {
    res.json({ status: 'ok', message: 'Joplin Server (mock) is running' });
  });

  app.post('/api/sessions', express.json(), (req, res) => {
    const { email, password } = req.body ?? {};
    if (email !== options.email || password !== options.password) {
      res.status(403).json({ error: 'Invalid username or password' });
      return;
    }
    const id = randomBytes(11).toString('base64url');
    sessions.add(id);
    res.json({ id, user_id: 'mockuser0000000000000000000000' });
  });

  app.use('/api/items', express.raw({ type: () => true, limit: '50mb' }), (req: Request, res: Response) => {
    const session = req.headers['x-api-auth'];
    if (typeof session !== 'string' || !sessions.has(session)) {
      res.status(403).json({ error: 'Invalid session' });
      return;
    }

    const match = ITEM_PATH.exec(decodeURIComponent(req.path));
    if (!match) {
      res.status(404).json({ error: `Unknown item path ${req.path}` });
      return;
    }
    const [, name, suffix] = match;

    if (req.method === 'GET' && suffix === '/children' && name === '') {
      // Resource binaries live in a sub-folder and are not listed at the root
      const all = [...items.entries()]
        .filter(([itemName]) => !itemName.startsWith('.resource/'))
        .map(([itemName, item]) => ({ id: itemName, name: itemName, updated_time: item.updatedTime }));
      const limit = Number(req.query.limit) || pageSize;
      const offset = Number(req.query.cursor) || 0;
      const page = all.slice(offset, offset + limit);
      const hasMore = offset + limit < all.length;
      res.json({ items: page, has_more: hasMore, cursor: hasMore ? String(offset + limit) : null });
      return;
    }

    if (req.method === 'GET' && suffix === '/content') {
      const item = items.get(name);
      if (!item) {
        res.status(404).json({ error: `Not found: ${name}` });
        return;
      }
      res.type(item.contentType).send(item.content);
      return;
    }

    if (req.method === 'PUT' && suffix === '/content') {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const file = parseMultipartFile(body, req.headers['content-type'] ?? '');
      if (!file) {
        res.status(400).json({ error: 'Expected multipart upload with a "file" field' });
        return;
      }
      const isResource = name.startsWith('.resource/');
      items.set(name, {
        content: Buffer.from(file),
        contentType: isResource ? 'application/octet-stream' : 'text/plain; charset=utf-8',
        updatedTime: tick(),
      });
      res.json({ name, updated_time: clock });
      return;
    }

    if (req.method === 'DELETE' && !suffix) {
      if (!items.delete(name)) {
        res.status(404).json({ error: `Not found: ${name}` });
        return;
      }
      res.status(200).end();
      return;
    }

    res.status(405).json({ error: `${req.method} not supported on ${req.path}` });
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s));
  });
  const { port: boundPort } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${boundPort}`,
    items,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
