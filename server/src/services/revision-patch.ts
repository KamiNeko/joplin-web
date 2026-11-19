/**
 * Pure parser and patch applier for Joplin item revision diffs (`title_diff` / `body_diff`).
 * Supports GNU diff-match-patch unidiff patch strings (`@@ -s1,l1 +s2,l2 @@`) as written by
 * Joplin's `RevisionService`, as well as JSON patch arrays if encountered.
 */

export const DIFF_EQUAL = 0;
export const DIFF_INSERT = 1;
export const DIFF_DELETE = -1;

export type DiffOp = [number, string];

export interface PatchObj {
  diffs: DiffOp[];
  start1: number;
  start2: number;
  length1: number;
  length2: number;
}

function safeDecode(raw: string): string {
  try {
    return decodeURI(raw.replace(/\+/g, '%2B').replace(/%20/g, ' '));
  } catch {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
}

function decodePatchLine(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return safeDecode(raw);
  }
}

export function parsePatchText(text: string): PatchObj[] {
  if (!text || !text.trim()) return [];
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (p): p is PatchObj =>
            Boolean(p) &&
            typeof p === 'object' &&
            Array.isArray((p as PatchObj).diffs) &&
            typeof (p as PatchObj).start1 === 'number' &&
            typeof (p as PatchObj).start2 === 'number'
        );
      }
    } catch {
      // Fall through to GNU patch text parser
    }
  }

  const patches: PatchObj[] = [];
  const lines = text.split(/\r?\n/);
  const headerRe = /^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@$/;
  let i = 0;

  while (i < lines.length) {
    const header = headerRe.exec(lines[i]);
    if (!header) {
      i++;
      continue;
    }

    const start1Raw = parseInt(header[1], 10);
    const length1 = header[2] === '' ? 1 : parseInt(header[2], 10);
    const start2Raw = parseInt(header[3], 10);
    const length2 = header[4] === '' ? 1 : parseInt(header[4], 10);

    const patch: PatchObj = {
      diffs: [],
      start1: length1 === 0 ? start1Raw : Math.max(0, start1Raw - 1),
      start2: length2 === 0 ? start2Raw : Math.max(0, start2Raw - 1),
      length1,
      length2,
    };

    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (!line) {
        i++;
        continue;
      }
      if (headerRe.test(line)) break;
      const sign = line[0];
      const payload = decodePatchLine(line.slice(1));
      if (sign === '+') {
        patch.diffs.push([DIFF_INSERT, payload]);
      } else if (sign === '-') {
        patch.diffs.push([DIFF_DELETE, payload]);
      } else if (sign === ' ') {
        patch.diffs.push([DIFF_EQUAL, payload]);
      } else if (sign === '\\') {
        // "\ No newline at end of file"
      } else {
        break;
      }
      i++;
    }

    patches.push(patch);
  }

  return patches;
}

function findBestMatch(text: string, pattern: string, expectedLoc: number): number {
  if (!pattern) return Math.min(Math.max(0, expectedLoc), text.length);
  const clamped = Math.min(Math.max(0, expectedLoc), text.length);
  if (text.startsWith(pattern, clamped)) return clamped;

  const forward = text.indexOf(pattern, clamped);
  const backward = text.lastIndexOf(pattern, clamped);
  if (forward === -1 && backward === -1) return clamped;
  if (forward === -1) return backward;
  if (backward === -1) return forward;
  return forward - clamped <= clamped - backward ? forward : backward;
}

export function applyPatchText(baseText: string, patchText: string): string {
  const patches = parsePatchText(patchText);
  if (patches.length === 0) return baseText;

  let text = baseText;
  let delta = 0;

  for (const patch of patches) {
    const expectedLoc = patch.start2 + delta;
    const expectedSource = patch.diffs
      .filter(([op]) => op !== DIFF_INSERT)
      .map(([, chunk]) => chunk)
      .join('');

    const loc = findBestMatch(text, expectedSource, expectedLoc);
    let pos = loc;
    const before = text.slice(0, pos);
    const outChunks: string[] = [before];

    for (const [op, chunk] of patch.diffs) {
      if (op === DIFF_EQUAL) {
        if (text.startsWith(chunk, pos)) {
          outChunks.push(chunk);
          pos += chunk.length;
        } else {
          outChunks.push(chunk);
        }
      } else if (op === DIFF_DELETE) {
        if (text.startsWith(chunk, pos)) {
          pos += chunk.length;
        }
      } else if (op === DIFF_INSERT) {
        outChunks.push(chunk);
      }
    }

    outChunks.push(text.slice(pos));
    const nextText = outChunks.join('');
    delta += nextText.length - text.length;
    text = nextText;
  }

  return text;
}

export interface RevisionDiffRecord {
  id: string;
  parentId: string;
  updatedTime: number;
  titleUpdatedTime: number;
  titleDiff: string;
  bodyDiff: string;
}

/**
 * Reconstructs `{ title, body }` for `targetId` by applying Joplin's chronological revision
 * diffs from `""` up through the target revision.
 */
export function reconstructRevisionContent(
  revisions: RevisionDiffRecord[],
  targetId: string
): { title: string; body: string } | null {
  if (revisions.length === 0) return null;

  const byId = new Map(revisions.map((r) => [r.id, r]));
  const target = byId.get(targetId);
  if (!target) return null;

  // Prefer tracing the parent chain backward from target if linked cleanly; fall back to
  // chronological order for any detached/merged chain segments.
  let chain: RevisionDiffRecord[] = [];
  if (target.parentId && byId.has(target.parentId)) {
    const visited = new Set<string>();
    let cur: RevisionDiffRecord | undefined = target;
    while (cur && !visited.has(cur.id)) {
      visited.add(cur.id);
      chain.push(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    chain.reverse();
  }

  if (chain.length <= 1 && revisions.length > 1 && target.parentId) {
    // Parent wasn't present locally (e.g. merged or out-of-band sync): use sorted sequence up to target
    const ordered = [...revisions].sort(
      (a, b) => a.titleUpdatedTime - b.titleUpdatedTime || a.updatedTime - b.updatedTime || a.id.localeCompare(b.id)
    );
    const idx = ordered.findIndex((r) => r.id === targetId);
    chain = idx >= 0 ? ordered.slice(0, idx + 1) : [target];
  } else if (chain.length === 0) {
    chain = [target];
  }

  let title = '';
  let body = '';
  for (const rev of chain) {
    if (rev.titleDiff) title = applyPatchText(title, rev.titleDiff);
    if (rev.bodyDiff) body = applyPatchText(body, rev.bodyDiff);
  }

  return { title, body };
}
