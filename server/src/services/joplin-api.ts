import axios, { AxiosError, AxiosInstance } from 'axios';
import { config } from '../config.js';
import {
  JoplinChildItem,
  JoplinChildrenResponse,
  SessionInfo,
} from '../types/index.js';

/**
 * Base custom error for Joplin API operations
 */
export class JoplinApiError extends Error {
  public status: number;
  public details?: unknown;

  constructor(message: string, status = 500, details?: unknown) {
    super(message);
    this.name = 'JoplinApiError';
    this.status = status;
    this.details = details;
  }
}

/**
 * Thrown when Joplin Server session is invalid or unauthorized
 */
export class JoplinAuthError extends JoplinApiError {
  constructor(message = 'Unauthorized or session expired', status = 401, details?: unknown) {
    super(message, status, details);
    this.name = 'JoplinAuthError';
  }
}

/**
 * Thrown when a requested resource/item is not found
 */
export class JoplinNotFoundError extends JoplinApiError {
  constructor(message = 'Item not found on Joplin Server', details?: unknown) {
    super(message, 404, details);
    this.name = 'JoplinNotFoundError';
  }
}

/**
 * Thrown when Joplin Server is unreachable or timed out
 */
export class JoplinConnectionError extends JoplinApiError {
  constructor(message = 'Failed to connect to Joplin Server', details?: unknown) {
    super(message, 503, details);
    this.name = 'JoplinConnectionError';
  }
}

/**
 * HTTP Client service for interacting with Joplin Server raw sync-target API
 */
export class JoplinApiService {
  private client: AxiosInstance;

  constructor(baseURL: string = config.joplinServerUrl) {
    this.client = axios.create({
      baseURL,
      timeout: 15000,
      headers: {
        'Accept': 'application/json, text/plain, */*',
      },
    });
  }

  /**
   * Helper to normalize and translate Axios errors into typed JoplinApiErrors
   */
  private handleError(error: unknown, context: string): never {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<{ error?: string; message?: string }>;
      const status = axiosError.response?.status;
      const responseData = axiosError.response?.data;
      const message =
        responseData?.error ||
        responseData?.message ||
        axiosError.message ||
        `Error during ${context}`;

      if (status === 401 || status === 403) {
        throw new JoplinAuthError(`[${context}] ${message}`, status, responseData);
      }
      if (status === 404) {
        throw new JoplinNotFoundError(`[${context}] ${message}`, responseData);
      }
      if (!axiosError.response || axiosError.code === 'ECONNREFUSED' || axiosError.code === 'ETIMEDOUT') {
        throw new JoplinConnectionError(
          `[${context}] Cannot connect to Joplin Server at ${this.client.defaults.baseURL}: ${axiosError.message}`,
          responseData
        );
      }

      throw new JoplinApiError(`[${context}] ${message}`, status || 500, responseData);
    }

    if (error instanceof JoplinApiError) {
      throw error;
    }

    throw new JoplinApiError(
      `[${context}] Unexpected error: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  /**
   * Pings the Joplin Server health check endpoint
   */
  public async ping(): Promise<{ status: string; message?: string }> {
    try {
      const res = await this.client.get('/api/ping');
      return res.data;
    } catch (error) {
      this.handleError(error, 'ping');
    }
  }

  /**
   * Authenticates with Joplin Server using email and password
   *
   * @param email Joplin Server account email
   * @param password Joplin Server account password
   * @returns Session ID and User ID
   */
  public async createSession(email: string, password: string): Promise<SessionInfo> {
    try {
      const res = await this.client.post('/api/sessions', { email, password });
      if (!res.data || !res.data.id) {
        throw new JoplinAuthError('Invalid response received from Joplin Server during login');
      }
      return {
        sessionId: res.data.id,
        userId: res.data.user_id,
      };
    } catch (error) {
      this.handleError(error, 'createSession');
    }
  }

  /**
   * Validates if a session ID is currently active and authorized by making a test API call
   *
   * @param sessionId Joplin Server session ID
   * @returns boolean true if valid, false if expired or invalid
   */
  public async checkSession(sessionId: string): Promise<boolean> {
    if (!sessionId) return false;
    try {
      const res = await this.client.get('/api/items/root:/:/children', {
        headers: { 'X-API-AUTH': sessionId },
        params: { limit: 1 },
      });
      return res.status >= 200 && res.status < 300;
    } catch (error: unknown) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 401 || status === 403) {
          return false;
        }
      }
      if (error instanceof JoplinAuthError) {
        return false;
      }
      // If network is completely unreachable, surface connection error
      this.handleError(error, 'checkSession');
    }
  }

  /**
   * Fetches all child items from Joplin Server, paginating through cursor until complete
   *
   * @param sessionId Active session ID
   * @returns List of all child items
   */
  public async listAllItems(sessionId: string): Promise<JoplinChildItem[]> {
    const allItems: JoplinChildItem[] = [];
    let cursor: string | null = null;
    let hasMore = true;
    let page = 1;

    while (hasMore) {
      try {
        const params: Record<string, string> = {};
        if (cursor) {
          params.cursor = cursor;
        }

        const res = await this.client.get<JoplinChildrenResponse>('/api/items/root:/:/children', {
          headers: { 'X-API-AUTH': sessionId },
          params,
        });

        const data = res.data;
        if (data && Array.isArray(data.items)) {
          allItems.push(...data.items);
        }

        hasMore = Boolean(data?.has_more);
        cursor = data?.cursor || null;
        page++;

        // Defensive guard to prevent infinite loops if has_more is true without cursor
        if (hasMore && !cursor) {
          break;
        }
      } catch (error) {
        this.handleError(error, `listAllItems (page ${page})`);
      }
    }

    return allItems;
  }

  /**
   * Retrieves the raw UTF-8 string content of an item
   *
   * @param sessionId Active session ID
   * @param itemName Name of the file on Joplin Server (e.g. "<id>.md")
   * @returns Raw text content
   */
  public async getItemContent(sessionId: string, itemName: string): Promise<string> {
    try {
      const cleanName = itemName.endsWith('.md') ? itemName : `${itemName}.md`;
      const res = await this.client.get(`/api/items/root:/${encodeURIComponent(cleanName)}:/content`, {
        headers: { 'X-API-AUTH': sessionId },
        responseType: 'text',
        // Prevent axios from automatically parsing string if it looks like JSON
        transformResponse: [(data) => data],
      });

      return typeof res.data === 'string' ? res.data : String(res.data ?? '');
    } catch (error) {
      this.handleError(error, `getItemContent(${itemName})`);
    }
  }

  /**
   * Retrieves binary resource content (e.g. images, attachments)
   *
   * @param sessionId Active session ID
   * @param resourceId 32-hex character resource ID
   * @returns Binary Buffer and contentType
   */
  public async getResourceBinary(
    sessionId: string,
    resourceId: string
  ): Promise<{ data: Buffer; contentType: string }> {
    try {
      const cleanId = resourceId.replace(/\.md$/i, '');
      const res = await this.client.get(
        `/api/items/root:/.resource/${encodeURIComponent(cleanId)}:/content`,
        {
          headers: { 'X-API-AUTH': sessionId },
          responseType: 'arraybuffer',
        }
      );

      const contentType = (res.headers['content-type'] as string) || 'application/octet-stream';
      const buffer = Buffer.from(res.data);
      return {
        data: buffer,
        contentType,
      };
    } catch (error) {
      this.handleError(error, `getResourceBinary(${resourceId})`);
    }
  }

  /**
   * Uploads content to a Joplin Server item path via multipart form upload
   */
  private async putItemContent(
    sessionId: string,
    itemPath: string,
    fileName: string,
    content: Buffer,
    context: string
  ): Promise<unknown> {
    try {
      const boundary = `----JoplinFormBoundary${Math.random().toString(36).substring(2)}`;
      const CRLF = '\r\n';

      const bodyParts: (string | Buffer)[] = [
        `--${boundary}${CRLF}`,
        `Content-Disposition: form-data; name="name"${CRLF}${CRLF}`,
        `${fileName}${CRLF}`,
        `--${boundary}${CRLF}`,
        `Content-Disposition: form-data; name="file"; filename="${fileName}"${CRLF}`,
        `Content-Type: application/octet-stream${CRLF}${CRLF}`,
        content,
        `${CRLF}--${boundary}--${CRLF}`,
      ];

      const bodyBuffer = Buffer.concat(
        bodyParts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'utf8') : p))
      );

      const res = await this.client.put(`/api/items/root:/${itemPath}:/content`, bodyBuffer, {
        headers: {
          'X-API-AUTH': sessionId,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': bodyBuffer.length,
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });

      return res.data;
    } catch (error) {
      this.handleError(error, context);
    }
  }

  /**
   * Creates or updates a raw item on Joplin Server via multipart form upload
   *
   * @param sessionId Active session ID
   * @param itemName Name of the file (e.g. "<id>.md")
   * @param content Raw serialized string content
   */
  public async createOrUpdateItem(
    sessionId: string,
    itemName: string,
    content: string
  ): Promise<unknown> {
    const cleanName = itemName.endsWith('.md') ? itemName : `${itemName}.md`;
    return this.putItemContent(
      sessionId,
      encodeURIComponent(cleanName),
      cleanName,
      Buffer.from(content, 'utf8'),
      `createOrUpdateItem(${itemName})`
    );
  }

  /**
   * Uploads the binary content of a resource (attachment) to ".resource/<id>"
   *
   * @param sessionId Active session ID
   * @param resourceId 32-hex character resource ID
   * @param data File content
   */
  public async uploadResourceBinary(sessionId: string, resourceId: string, data: Buffer): Promise<void> {
    await this.putItemContent(
      sessionId,
      `.resource/${encodeURIComponent(resourceId)}`,
      resourceId,
      data,
      `uploadResourceBinary(${resourceId})`
    );
  }

  /**
   * Permanently deletes a resource's binary (".resource/<id>"). Missing files are ignored.
   */
  public async deleteResourceBinary(sessionId: string, resourceId: string): Promise<void> {
    try {
      await this.client.delete(`/api/items/root:/.resource/${encodeURIComponent(resourceId)}:`, {
        headers: { 'X-API-AUTH': sessionId },
      });
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return;
      }
      this.handleError(error, `deleteResourceBinary(${resourceId})`);
    }
  }

  /**
   * Permanently deletes a raw item from Joplin Server. Missing items are treated as already deleted.
   *
   * @param sessionId Active session ID
   * @param itemName Name of the file (e.g. "<id>.md")
   */
  public async deleteItem(sessionId: string, itemName: string): Promise<void> {
    try {
      const cleanName = itemName.endsWith('.md') ? itemName : `${itemName}.md`;
      await this.client.delete(`/api/items/root:/${encodeURIComponent(cleanName)}:`, {
        headers: { 'X-API-AUTH': sessionId },
      });
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return;
      }
      this.handleError(error, `deleteItem(${itemName})`);
    }
  }
}

// Export singleton instance
export const joplinApi = new JoplinApiService();
