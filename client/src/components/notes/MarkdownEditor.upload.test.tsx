import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { createRef, useState } from "react";
import { toast } from "sonner";
import { FetchCall, jsonResponse, mockFetch } from "@/test/fetch-mock";
import { EditorView } from "@uiw/react-codemirror";
import { MarkdownEditor, MarkdownEditorHandle, UPLOAD_PLACEHOLDER } from "./MarkdownEditor";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const resourceId = "0123456789abcdef0123456789abcdef";

/** Controlled editor like NoteEditor uses it; exposes the current text and upload count */
function renderEditor(initial = "") {
  const ref = createRef<MarkdownEditorHandle>();
  const state = { value: initial, pending: [] as number[] };
  function Harness() {
    const [value, setValue] = useState(initial);
    return (
      <MarkdownEditor
        ref={ref}
        value={value}
        onChange={(next) => {
          state.value = next;
          setValue(next);
        }}
        onUploadsChange={(n) => state.pending.push(n)}
      />
    );
  }
  render(<Harness />);
  return { ref, state };
}

/** Upload endpoint stub; resolves when `release` is called so the placeholder can be observed */
function mockUpload(answer: (call: FetchCall) => Response = () =>
  jsonResponse({ id: resourceId, title: "photo [1].png", mime: "image/png", size: 4 })
) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const calls = mockFetch(async (call) => {
    if (call.path !== "/api/resources") return undefined;
    await gate;
    return answer(call);
  });
  return { calls, release };
}

// CodeMirror measures text; jsdom has no layout
beforeAll(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});

afterEach(cleanup);

function editorView(): EditorView {
  return EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
}

describe("MarkdownEditor uploads", () => {
  it("inserts a placeholder at the cursor while uploading, then an image link to the resource", async () => {
    const { calls, release } = mockUpload();
    const { ref, state } = renderEditor("Intro ");
    const file = new File(["data"], "photo [1].png", { type: "image/png" });
    editorView().dispatch({ selection: { anchor: 6 } });

    ref.current!.insertFiles([file]);

    await waitFor(() => expect(state.value).toMatch(/^Intro !\[Uploading photo \(1\)\.png…\]\(uploading-[a-z0-9]+\)$/));
    expect(state.value.match(UPLOAD_PLACEHOLDER)).toHaveLength(1);
    expect(state.pending).toEqual([1]);

    const upload = calls.find((c) => c.path === "/api/resources")!;
    expect(upload.method).toBe("POST");
    expect(upload.body).toBe(file);

    release();
    await waitFor(() => expect(state.value).toBe(`Intro ![photo (1).png](:/${resourceId})`));
    expect(state.pending).toEqual([1, 0]);
  });

  it("sends the file name and type as headers and links other files without '!'", async () => {
    const { release } = mockUpload(() => jsonResponse({ id: resourceId, title: "Q3 report.pdf", mime: "application/pdf", size: 4 }));
    const fetchSpy = vi.mocked(fetch);
    const { ref, state } = renderEditor();

    ref.current!.insertFiles([new File(["%PDF"], "Q3 report.pdf", { type: "application/pdf" })]);
    release();

    await waitFor(() => expect(state.value).toBe(`[Q3 report.pdf](:/${resourceId})`));
    const headers = fetchSpy.mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/octet-stream");
    expect(headers["X-File-Name"]).toBe("Q3%20report.pdf");
    expect(headers["X-File-Type"]).toBe("application/pdf");
  });

  it("puts several files on their own lines", async () => {
    let n = 0;
    const { release } = mockUpload(() => {
      n++;
      return jsonResponse({ id: String(n).repeat(32), title: `f${n}.txt`, mime: "text/plain", size: 1 });
    });
    const { ref, state } = renderEditor();

    ref.current!.insertFiles([new File(["a"], "a.txt", { type: "text/plain" }), new File(["b"], "b.txt", { type: "text/plain" })]);
    await waitFor(() => expect(state.pending).toEqual([1, 2]));
    release();

    await waitFor(() => expect(state.pending[state.pending.length - 1]).toBe(0));
    expect(state.value).toBe(`[f1.txt](:/${"1".repeat(32)})\n[f2.txt](:/${"2".repeat(32)})\n`);
  });

  it("removes the placeholder and reports a failed upload", async () => {
    const { release } = mockUpload(() => jsonResponse({ error: "File too large" }, 413));
    const { ref, state } = renderEditor("Text");

    ref.current!.insertFiles([new File(["x"], "big.zip", { type: "application/zip" })]);
    await waitFor(() => expect(state.value).toContain("Uploading big.zip"));
    release();

    await waitFor(() => expect(state.value).toBe("Text"));
    expect(state.pending).toEqual([1, 0]);
    expect(toast.error).toHaveBeenCalledWith('Could not upload "big.zip"', { description: "File too large" });
  });

  it("keeps the user's typing around a placeholder when the upload finishes", async () => {
    const { release } = mockUpload();
    const { ref, state } = renderEditor();

    ref.current!.insertFiles([new File(["data"], "photo.png", { type: "image/png" })]);
    await waitFor(() => expect(state.value).toContain("Uploading"));
    // The user types before and after the placeholder while the upload runs
    const view = editorView();
    view.dispatch({ changes: { from: 0, insert: "Before " } });
    view.dispatch({ changes: { from: view.state.doc.length, insert: " after" } });
    release();

    await waitFor(() => expect(state.value).toBe(`Before ![photo (1).png](:/${resourceId}) after`));
  });
});
