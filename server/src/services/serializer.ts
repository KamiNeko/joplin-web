import { JoplinItemType, RawJoplinItem } from '../types/index.js';

/**
 * Deserializes raw Joplin sync-target text content into a structured RawJoplinItem object.
 *
 * According to the Joplin specification, parsing reads from the bottom up:
 * 1. Collects `key: value` property pairs starting from the last line.
 * 2. Stops at the first blank line encountered.
 * 3. The lines above that blank line represent the body section:
 *    - First line is title
 *    - Next blank line is skipped
 *    - Remaining lines are the markdown body (for notes, type_ = 1)
 *
 * @param rawContent Raw text content from Joplin Server item
 * @param defaultId Optional fallback ID (e.g. from filename "<id>.md") if 'id' property is blank
 * @returns Parsed RawJoplinItem
 */
export function deserialize(rawContent: string, defaultId?: string): RawJoplinItem {
  if (typeof rawContent !== 'string') {
    throw new Error('Cannot deserialize non-string content');
  }

  // Split lines (handling both \r\n and \n)
  const lines = rawContent.split(/\r?\n/);
  const properties: Record<string, string> = {};
  let bodyLines: string[] = [];

  // Parse from bottom up
  for (let i = lines.length - 1; i >= 0; i--) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // The properties section is separated from the body section by a blank line
    if (trimmed === '') {
      bodyLines = lines.slice(0, i);
      break;
    }

    const colonIdx = rawLine.indexOf(':');
    if (colonIdx >= 0) {
      const key = rawLine.slice(0, colonIdx).trim();
      let value = rawLine.slice(colonIdx + 1).trim();

      // Unescape escaped newlines and carriage returns in property values
      value = value
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\\n/g, '\\n')
        .replace(/\\\r/g, '\\r');

      properties[key] = value;
    }
  }

  // Parse type_
  const type_ = properties.type_ ? parseInt(properties.type_, 10) : JoplinItemType.Note;

  // Extract title and body from bodyLines
  let title = '';
  let body = '';

  if (bodyLines.length > 0) {
    title = bodyLines[0];

    // If there is more content after title, skip blank separator line if present
    if (bodyLines.length > 1) {
      if (bodyLines[1] === '') {
        body = bodyLines.slice(2).join('\n');
      } else {
        body = bodyLines.slice(1).join('\n');
      }
    }
  }

  // Fallback to title in properties if empty in body section
  if (!title && properties.title) {
    title = properties.title;
  }

  // Only notes (type_ = 1) have a body in Joplin
  if (type_ !== JoplinItemType.Note) {
    body = '';
  }

  // Resolve ID
  let id = properties.id || '';
  if (!id && defaultId) {
    id = defaultId.replace(/\.md$/i, '');
  }

  // Parse timestamps (ISO strings or numeric timestamps)
  const parseTimestamp = (val?: string): number => {
    if (!val) return 0;
    const num = Number(val);
    if (!isNaN(num) && num > 0) return num;
    const parsed = Date.parse(val);
    return isNaN(parsed) ? 0 : parsed;
  };

  const createdTime = parseTimestamp(properties.created_time || properties.user_created_time);
  const updatedTime = parseTimestamp(properties.updated_time || properties.user_updated_time);
  const userCreatedTime = parseTimestamp(properties.user_created_time || properties.created_time);
  const userUpdatedTime = parseTimestamp(properties.user_updated_time || properties.updated_time);

  const parentId = properties.parent_id || '';
  const isTodo = properties.is_todo === '1';
  const todoCompleted = properties.todo_completed ? Number(properties.todo_completed) : 0;
  const todoDue = properties.todo_due ? Number(properties.todo_due) : 0;

  return {
    id,
    type_,
    title,
    body,
    parentId,
    createdTime,
    updatedTime,
    userCreatedTime,
    userUpdatedTime,
    isTodo,
    todoCompleted,
    todoDue,
    properties,
  };
}

/**
 * Serializes an item back into Joplin's sync-target text format.
 * Format: title + '\n\n' + body + '\n\n' + properties joined by '\n'
 *
 * @param item Item to serialize
 * @returns Raw serialized string ready for Joplin Server
 */
export function serialize(item: {
  type_: number;
  id?: string;
  title?: string;
  body?: string;
  parentId?: string;
  parent_id?: string;
  createdTime?: number | string;
  updatedTime?: number | string;
  userCreatedTime?: number | string;
  userUpdatedTime?: number | string;
  created_time?: number | string;
  updated_time?: number | string;
  user_created_time?: number | string;
  user_updated_time?: number | string;
  isTodo?: boolean;
  is_todo?: number | boolean;
  todoDue?: number;
  todo_due?: number;
  todoCompleted?: number;
  todo_completed?: number;
  properties?: Record<string, any>;
  [key: string]: any;
}): string {
  const props: Record<string, string> = {
    ...(item.properties || {}),
  };

  if (item.id !== undefined) props.id = item.id;
  const parentId = item.parentId ?? item.parent_id;
  if (parentId !== undefined) props.parent_id = parentId;

  const formatDate = (val: any): string => {
    if (!val) return '';
    if (typeof val === 'string' && val.includes('T')) return val;
    const num = Number(val);
    if (!isNaN(num) && num > 0) {
      return new Date(num).toISOString();
    }
    return '';
  };

  const createdTime = item.created_time ?? item.createdTime;
  if (createdTime !== undefined) props.created_time = formatDate(createdTime);

  const updatedTime = item.updated_time ?? item.updatedTime;
  if (updatedTime !== undefined) props.updated_time = formatDate(updatedTime);

  const userCreatedTime = item.user_created_time ?? item.userCreatedTime ?? createdTime;
  if (userCreatedTime !== undefined) props.user_created_time = formatDate(userCreatedTime);

  const userUpdatedTime = item.user_updated_time ?? item.userUpdatedTime ?? updatedTime;
  if (userUpdatedTime !== undefined) props.user_updated_time = formatDate(userUpdatedTime);

  if (item.isTodo !== undefined || item.is_todo !== undefined) {
    props.is_todo = (item.isTodo || item.is_todo === 1 || item.is_todo === true) ? '1' : '0';
  }
  if (item.todoDue !== undefined || item.todo_due !== undefined) {
    props.todo_due = String(item.todoDue ?? item.todo_due ?? 0);
  }
  if (item.todoCompleted !== undefined || item.todo_completed !== undefined) {
    props.todo_completed = String(item.todoCompleted ?? item.todo_completed ?? 0);
  }

  props.type_ = String(item.type_);

  // Format properties section
  const propLines: string[] = [];
  for (const [key, val] of Object.entries(props)) {
    if (key === 'title' || key === 'body') continue;
    let strVal = val === null || val === undefined ? '' : String(val);
    // Escape newlines in property values
    strVal = strVal
      .replace(/\\n/g, '\\\\n')
      .replace(/\\r/g, '\\\\r')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r');
    propLines.push(`${key}: ${strVal}`);
  }

  const sections: string[] = [];
  if (item.title) {
    sections.push(item.title);
  }
  if (item.body && item.type_ === JoplinItemType.Note) {
    sections.push(item.body);
  }
  if (propLines.length > 0) {
    sections.push(propLines.join('\n'));
  }

  return sections.join('\n\n');
}

/**
 * Strips markdown markup to create a clean plaintext preview snippet.
 * Truncates to maxChars (default 150) and appends ellipsis if truncated.
 *
 * @param markdown Input markdown string
 * @param maxChars Maximum character length of preview
 * @returns Clean plaintext snippet
 */
export function stripMarkdown(markdown?: string, maxChars = 150): string {
  if (!markdown) return '';

  const text = markdown
    // Remove code blocks
    .replace(/```[\s\S]*?```/g, '')
    // Remove inline code
    .replace(/`([^`]+)`/g, '$1')
    // Remove images: ![alt](url)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '')
    // Replace links with label text: [text](url) -> text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Remove headings: # Heading
    .replace(/^#{1,6}\s+/gm, '')
    // Remove blockquotes: > quote
    .replace(/^>\s+/gm, '')
    // Remove horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, '')
    // Remove unordered list markers: - item, * item
    .replace(/^[\*\-+]\s+/gm, '')
    // Remove ordered list markers: 1. item
    .replace(/^\d+\.\s+/gm, '')
    // Remove bold and italic formatting
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    // Remove strikethrough
    .replace(/~~(.*?)~~/g, '$1')
    // Remove HTML tags
    .replace(/<[^>]+>/g, '')
    // Collapse consecutive whitespaces and newlines into single spaces
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length <= maxChars) {
    return text;
  }

  // Truncate at word boundary when possible
  const truncated = text.substring(0, maxChars);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxChars * 0.7) {
    return `${truncated.substring(0, lastSpace)}...`;
  }
  return `${truncated}...`;
}
