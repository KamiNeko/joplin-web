/**
 * Remark plugins for the Markdown extensions Joplin renders by default (markdown-it-mark, -ins,
 * -sub and -sup, and KaTeX's dollar rules), so notes look the same as in the Joplin apps:
 *
 * - `==mark==` → <mark>, `++inserted++` → <ins> (delimiter runs like ~~strikethrough~~, inline
 *   Markdown inside is parsed)
 * - `~sub~` → <sub>, `^sup^` → <sup> (plain text up to the next marker; unescaped whitespace ends
 *   the match, as in markdown-it-sub/-sup). remark-gfm must run with `singleTilde: false` so a
 *   single `~` is not strikethrough.
 *
 * These are micromark extensions, so code spans, code blocks and escapes behave as everywhere
 * else in Markdown, and source positions (used to map task checkboxes back to the text) stay exact.
 */

// Minimal local shapes of micromark/mdast-util-from-markdown types (those packages are only
// transitive dependencies of react-markdown).
type Code = number | null;
type State = (code: Code) => State | undefined;
interface Point {
  line: number;
  column: number;
  offset: number;
}
interface Token {
  type: string;
  start: Point;
  end: Point;
  _open?: boolean;
  _close?: boolean;
}
type Event = ["enter" | "exit", Token, TokenizeContext];
interface Construct {
  name?: string;
  tokenize: (this: TokenizeContext, effects: Effects, ok: State, nok: State) => State;
  resolveAll?: (events: Event[], context: TokenizeContext) => Event[];
}
interface TokenizeContext {
  previous: Code;
  events: Event[];
  parser: { constructs: { insideSpan: { null?: Construct[] } } };
}
interface Effects {
  enter: (type: string) => Token;
  exit: (type: string) => Token;
  consume: (code: Code) => void;
}
interface MicromarkExtension {
  text?: Record<number, Construct>;
  insideSpan?: { null: Construct[] };
  attentionMarkers?: { null: number[] };
}
interface MdastLike {
  type: string;
  value?: string;
  data?: Record<string, unknown>;
  children?: MdastLike[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}
interface FromMarkdownContext {
  enter: (node: MdastLike, token: Token) => void;
  exit: (token: Token) => void;
  sliceSerialize: (token: Token) => string;
}
type FromMarkdownHandle = (this: FromMarkdownContext, token: Token) => void;
interface FromMarkdownExtension {
  enter?: Record<string, FromMarkdownHandle>;
  exit?: Record<string, FromMarkdownHandle>;
}
interface ProcessorLike {
  data: () => { micromarkExtensions?: unknown[]; fromMarkdownExtensions?: unknown[] };
}

const BACKSLASH = 92;
// Backslash-escapable characters as in markdown-it (ASCII punctuation, plus space for sub/sup)
const UNESCAPE = /\\([ \\!"#$%&'()*+,./:;<=>?@[\]^_`{|}~-])/g;

/** Whitespace or line ending (micromark uses negative codes for line endings and tabs) */
function isSpace(code: Code): boolean {
  return code === null || code < 0 || /\s/u.test(String.fromCodePoint(code));
}

/** Like micromark-util-classify-character: 1 = whitespace, 2 = punctuation, undefined = other */
function classify(code: Code): 1 | 2 | undefined {
  if (isSpace(code)) return 1;
  if (/[\p{P}\p{S}]/u.test(String.fromCodePoint(code as number))) return 2;
  return undefined;
}

/**
 * Delimiter-run span with a doubled marker (`==` or `++`), modelled on GFM strikethrough
 * (micromark-extension-gfm-strikethrough). Runs of any other length stay literal text.
 */
function doubleMarkerSyntax(name: string, marker: number): MicromarkExtension {
  const temporary = `${name}SequenceTemporary`;

  function resolveAll(events: Event[], context: TokenizeContext): Event[] {
    let index = -1;
    while (++index < events.length) {
      if (events[index][0] !== "enter" || events[index][1].type !== temporary || !events[index][1]._close) continue;
      let open = index;
      while (open--) {
        if (events[open][0] !== "exit" || events[open][1].type !== temporary || !events[open][1]._open) continue;
        events[index][1].type = `${name}Sequence`;
        events[open][1].type = `${name}Sequence`;
        const span: Token = { type: name, start: { ...events[open][1].start }, end: { ...events[index][1].end } };
        const text: Token = { type: `${name}Text`, start: { ...events[open][1].end }, end: { ...events[index][1].start } };
        let between = events.slice(open + 1, index);
        // Resolve attention (emphasis, strikethrough, …) inside the span
        for (const construct of context.parser.constructs.insideSpan.null ?? []) {
          if (construct.resolveAll) between = construct.resolveAll(between, context);
        }
        const next: Event[] = [
          ["enter", span, context],
          ["enter", events[open][1], context],
          ["exit", events[open][1], context],
          ["enter", text, context],
          ...between,
          ["exit", text, context],
          ["enter", events[index][1], context],
          ["exit", events[index][1], context],
          ["exit", span, context],
        ];
        events.splice(open - 1, index - open + 3, ...next);
        index = open + next.length - 2;
        break;
      }
    }
    for (const event of events) {
      if (event[1].type === temporary) event[1].type = "data";
    }
    return events;
  }

  function tokenize(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
    const previous = this.previous;
    const events = this.events;
    let size = 0;
    const more: State = (code) => {
      if (code === marker) {
        if (size > 1) return nok(code);
        effects.consume(code);
        size++;
        return more;
      }
      if (size < 2) return nok(code);
      const token = effects.exit(temporary);
      const before = classify(previous);
      const after = classify(code);
      token._open = !after || (after === 2 && Boolean(before));
      token._close = !before || (before === 2 && Boolean(after));
      return ok(code);
    };
    return (code) => {
      if (previous === marker && events[events.length - 1]?.[1].type !== "characterEscape") return nok(code);
      effects.enter(temporary);
      return more(code);
    };
  }

  const construct: Construct = { name, tokenize, resolveAll };
  return { text: { [marker]: construct }, insideSpan: { null: [construct] }, attentionMarkers: { null: [marker] } };
}

/**
 * Single-marker span (`~sub~`, `^sup^`): the text up to the next marker, which must not be empty
 * or contain unescaped whitespace (markdown-it-sub/-sup).
 */
function singleMarkerSyntax(name: string, marker: number): MicromarkExtension {
  function tokenize(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
    const previous = this.previous;
    const events = this.events;
    const escaped: State = (code) => {
      if (code === null || code < 0) return nok(code);
      effects.consume(code);
      return inside;
    };
    const inside: State = (code) => {
      if (code === marker) {
        effects.exit(`${name}Content`);
        effects.enter(`${name}Marker`);
        effects.consume(code);
        effects.exit(`${name}Marker`);
        effects.exit(name);
        return ok;
      }
      if (isSpace(code)) return nok(code);
      effects.consume(code);
      return code === BACKSLASH ? escaped : inside;
    };
    const contentStart: State = (code) => {
      // "~~" is strikethrough, "~ " is no subscript
      if (code === marker || isSpace(code)) return nok(code);
      effects.enter(`${name}Content`);
      return inside(code);
    };
    return (code) => {
      if (previous === marker && events[events.length - 1]?.[1].type !== "characterEscape") return nok(code);
      effects.enter(name);
      effects.enter(`${name}Marker`);
      effects.consume(code);
      effects.exit(`${name}Marker`);
      return contentStart;
    };
  }
  return { text: { [marker]: { name, tokenize } } };
}

/** Turns the tokens of one extension into an mdast node rendered as `tagName` */
function spanFromMarkdown(name: string, tagName: string, textContent: boolean): FromMarkdownExtension {
  return {
    enter: {
      [name](token) {
        this.enter({ type: name, data: { hName: tagName }, children: [] }, token);
      },
    },
    exit: {
      [name](token) {
        this.exit(token);
      },
      ...(textContent
        ? {
            [`${name}Content`](this: FromMarkdownContext, token: Token) {
              this.enter({ type: "text", value: this.sliceSerialize(token).replace(UNESCAPE, "$1") }, token);
              this.exit(token);
            },
          }
        : {}),
    },
  };
}

/**
 * Remark plugin adding Joplin's ==mark==, ++insert++, ~sub~ and ^sup^ syntax.
 * Use together with `remarkGfm` configured with `{ singleTilde: false }`.
 */
export function remarkJoplinMarkup(this: ProcessorLike) {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(
    doubleMarkerSyntax("mark", 61 /* = */),
    doubleMarkerSyntax("insert", 43 /* + */),
    singleMarkerSyntax("subscript", 126 /* ~ */),
    singleMarkerSyntax("superscript", 94 /* ^ */)
  );
  (data.fromMarkdownExtensions ??= []).push(
    spanFromMarkdown("mark", "mark", false),
    spanFromMarkdown("insert", "ins", false),
    spanFromMarkdown("subscript", "sub", true),
    spanFromMarkdown("superscript", "sup", true)
  );
}

/**
 * Remark plugin (after remark-math) applying the dollar rules of Joplin's KaTeX plugin to
 * `$inline$` math: the formula must not start or end with whitespace and the closing `$` must not
 * be followed by a digit, so "costs $5 and $10" stays text. `$$…$$` within a line is display math.
 */
export function remarkJoplinMath() {
  return (tree: MdastLike, file: { value?: unknown }) => {
    const source = typeof file.value === "string" ? file.value : String(file.value ?? "");
    const walk = (node: MdastLike) => {
      node.children?.forEach((child, index, siblings) => {
        if (child.type !== "inlineMath") return walk(child);
        const start = child.position?.start.offset;
        const end = child.position?.end.offset;
        if (start === undefined || end === undefined) return;
        const raw = source.slice(start, end);
        if (raw.startsWith("$$")) {
          child.data = { ...child.data, hProperties: { className: ["language-math", "math-display"] } };
          return;
        }
        const value = child.value ?? "";
        if (/^\s|\s$/.test(value) || /^\d/.test(source.slice(end))) {
          siblings[index] = { type: "text", value: raw, position: child.position };
        }
      });
    };
    walk(tree);
  };
}
