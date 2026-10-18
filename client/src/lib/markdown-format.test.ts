import { describe, expect, it } from "vitest";
import {
  applyChanges,
  escapeLinkText,
  FormatResult,
  insertLink,
  insertNoteLink,
  noteMarkdownLink,
  TextSelection,
  toggleCode,
  toggleHeading,
  toggleList,
  toggleWrap,
} from "./markdown-format";

/**
 * Runs a transform on text with the selection written inline: `«` and `»` mark a selection,
 * `|` a cursor. Returns the result written the same way.
 */
function run(input: string, transform: (text: string, sel: TextSelection) => FormatResult): string {
  const cursor = input.indexOf("|");
  let text: string;
  let sel: TextSelection;
  if (cursor >= 0) {
    text = input.slice(0, cursor) + input.slice(cursor + 1);
    sel = { from: cursor, to: cursor };
  } else {
    const from = input.indexOf("«");
    const to = input.indexOf("»", from) - 1;
    text = input.slice(0, from) + input.slice(from + 1, to + 1) + input.slice(to + 2);
    sel = { from, to };
  }
  const result = transform(text, sel);
  const out = applyChanges(text, result.changes);
  const { from, to } = result.selection;
  if (from === to) return out.slice(0, from) + "|" + out.slice(from);
  return out.slice(0, from) + "«" + out.slice(from, to) + "»" + out.slice(to);
}

const bold = (t: string, s: TextSelection) => toggleWrap(t, s, "**");
const italic = (t: string, s: TextSelection) => toggleWrap(t, s, "*");
const strike = (t: string, s: TextSelection) => toggleWrap(t, s, "~~");

describe("toggleWrap", () => {
  it("wraps and unwraps a selection", () => {
    expect(run("a «word» b", bold)).toBe("a **«word»** b");
    expect(run("a **«word»** b", bold)).toBe("a «word» b");
    expect(run("a «**word**» b", bold)).toBe("a «word» b");
    expect(run("a «word» b", strike)).toBe("a ~~«word»~~ b");
  });

  it("keeps whitespace at the selection ends outside the markers", () => {
    expect(run("a« word »b", bold)).toBe("a **«word»** b");
  });

  it("does not take bold for italic or the other way round", () => {
    expect(run("**«word»**", italic)).toBe("***«word»***");
    expect(run("***«word»***", italic)).toBe("**«word»**");
    expect(run("***«word»***", bold)).toBe("*«word»*");
    expect(run("*«word»*", bold)).toBe("***«word»***");
    expect(run("*«word»*", italic)).toBe("«word»");
  });

  it("wraps the word around a cursor, keeping the cursor's place", () => {
    expect(run("say he|llo now", bold)).toBe("say **he|llo** now");
    expect(run("say **he|llo** now", bold)).toBe("say he|llo now");
    expect(run("say héllo|", italic)).toBe("say *héllo*|");
  });

  it("inserts and removes an empty pair away from words", () => {
    expect(run("a | b", bold)).toBe("a **|** b");
    expect(run("a **|** b", bold)).toBe("a | b");
    expect(run("|", italic)).toBe("*|*");
  });

  it("leaves a whitespace-only selection alone", () => {
    expect(run("a«  »b", bold)).toBe("a«  »b");
  });
});

describe("toggleCode", () => {
  it("wraps inline code within a line", () => {
    expect(run("run «npm ci» now", toggleCode)).toBe("run `«npm ci»` now");
    expect(run("run `«npm ci»` now", toggleCode)).toBe("run «npm ci» now");
  });

  it("fences a selection over several lines and removes the fences again", () => {
    expect(run("x\n«a\nb»\ny", toggleCode)).toBe("x\n```\n«a\nb»\n```\ny");
    expect(run("x\n```\n«a\nb»\n```\ny", toggleCode)).toBe("x\n«a\nb»\ny");
  });
});

describe("toggleHeading", () => {
  it("adds, changes and removes a heading on the cursor line", () => {
    expect(run("Ti|tle\nnext", (t, s) => toggleHeading(t, s, 2))).toBe("## Ti|tle\nnext");
    expect(run("# Ti|tle", (t, s) => toggleHeading(t, s, 2))).toBe("## Ti|tle");
    expect(run("## Ti|tle", (t, s) => toggleHeading(t, s, 2))).toBe("Ti|tle");
    expect(run("|", (t, s) => toggleHeading(t, s, 1))).toBe("# |");
  });

  it("does not treat a hashtag as a heading", () => {
    expect(run("#tag|", (t, s) => toggleHeading(t, s, 1))).toBe("# #tag|");
  });
});

describe("toggleList", () => {
  const bullet = (t: string, s: TextSelection) => toggleList(t, s, "bullet");
  const numbered = (t: string, s: TextSelection) => toggleList(t, s, "numbered");
  const checkbox = (t: string, s: TextSelection) => toggleList(t, s, "checkbox");

  it("toggles a bullet on the cursor line", () => {
    expect(run("it|em", bullet)).toBe("- it|em");
    expect(run("- it|em", bullet)).toBe("it|em");
    expect(run("|", bullet)).toBe("- |");
  });

  it("numbers selected lines, skipping empty ones and keeping indentation", () => {
    expect(run("«a\n\n  b\nc»", numbered)).toBe("1. «a\n\n  2. b\n3. c»");
    expect(run("«1. a\n2. b»", numbered)).toBe("«a\nb»");
  });

  it("converts other list kinds", () => {
    expect(run("«- a\n3. b»", checkbox)).toBe("- [ ] «a\n- [ ] b»");
    expect(run("- [x] do|ne", bullet)).toBe("- do|ne");
  });

  it("keeps the state of existing checkboxes", () => {
    expect(run("«- [x] a\nb»", checkbox)).toBe("«- [x] a\n- [ ] b»");
    expect(run("«- [x] a\n- [ ] b»", checkbox)).toBe("«a\nb»");
  });

  it("ignores a line the selection only touches at its start", () => {
    expect(run("«a\n»b", bullet)).toBe("- «a\n»b");
  });
});

describe("links", () => {
  it("inserts an empty link or wraps the selection", () => {
    expect(run("see |", insertLink)).toBe("see [|]()");
    expect(run("see «docs» now", insertLink)).toBe("see [docs](|) now");
    expect(run("see «https://example.com/a» now", insertLink)).toBe("see [|](https://example.com/a) now");
  });

  it("links to a note with its title or the selected text", () => {
    const note = { id: "0123456789abcdef0123456789abcdef", title: "Plan [v2]" };
    expect(run("see |", (t, s) => insertNoteLink(t, s, note))).toBe(
      "see [Plan \\[v2\\]](:/0123456789abcdef0123456789abcdef)|"
    );
    expect(run("see «this»", (t, s) => insertNoteLink(t, s, note))).toBe(
      "see [this](:/0123456789abcdef0123456789abcdef)|"
    );
  });

  it("builds note links with escaped titles", () => {
    expect(escapeLinkText("a\\b[c]")).toBe("a\\\\b\\[c\\]");
    expect(noteMarkdownLink({ id: "abc", title: "  " })).toBe("[Untitled](:/abc)");
  });
});
