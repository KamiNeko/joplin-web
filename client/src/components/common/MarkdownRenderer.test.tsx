import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { clearResourceCache } from "@/lib/api";
import { resetConnection } from "@/lib/connection";
import { FetchCall, jsonResponse, mockFetch } from "@/test/fetch-mock";
import { MarkdownRenderer } from "./MarkdownRenderer";

const pdfjsMock = vi.hoisted(() => ({
  GlobalWorkerOptions: { workerSrc: "" },
  VerbosityLevel: { ERRORS: 0 },
  getDocument: vi.fn(),
}));
vi.mock("pdfjs-dist", () => pdfjsMock);
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "/assets/pdf.worker.min.mjs" }));

const RES_ID = "0123456789abcdef0123456789abcdef";
const RES_ID_2 = "11111111111111111111111111111111";
const NOTE_ID = "fedcba9876543210fedcba9876543210";
const GONE_ID = "a".repeat(32);

function OpenedNote() {
  return <p>Opened note {useParams().id}</p>;
}

function renderMarkdown(content: string, html = false) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<MarkdownRenderer content={content} html={html} />} />
          <Route path="/notes/:id" element={<OpenedNote />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  ).container;
}

let calls: FetchCall[];
let downloads: string[];

function mockPdfDocument(numPages = 12, width = 612, height = 792) {
  const destroy = vi.fn(async () => undefined);
  const cleanup = vi.fn(async () => undefined);
  const renderPage = vi.fn(() => ({ promise: Promise.resolve() }));
  const getPage = vi.fn(async () => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: width * scale, height: height * scale }),
    render: renderPage,
    cleanup: vi.fn(),
  }));
  pdfjsMock.getDocument.mockReturnValue({
    promise: Promise.resolve({ numPages, getPage, cleanup }),
    destroy,
  });
  return { destroy, cleanup, renderPage, getPage };
}

beforeEach(() => {
  resetConnection();
  clearResourceCache();
  downloads = [];
  pdfjsMock.getDocument.mockReset();
  mockPdfDocument();
  // jsdom has no object URLs or 2D canvas implementation
  URL.createObjectURL = vi.fn(() => "blob:resource");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => ({ fillStyle: "", fillRect: vi.fn() }) as unknown as RenderingContext
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
    callback(new Blob(["thumb"], { type: "image/png" }));
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    if (this.hasAttribute("download")) downloads.push(this.download);
  });
  calls = mockFetch(({ path }) => {
    if (path === `/api/resources/${RES_ID}` || path === `/api/resources/${RES_ID_2}`) {
      return new Response(new Blob(["png"], { type: "image/png" }), { headers: { "Content-Type": "image/png" } });
    }
    if (path === `/api/resources/${RES_ID}?view=pdf` || path === `/api/resources/${RES_ID_2}?view=pdf`) {
      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { headers: { "Content-Type": "application/pdf" } });
    }
    if (path === `/api/resources/${NOTE_ID}` || path === `/api/resources/${NOTE_ID}?view=pdf`) {
      return jsonResponse({ error: "Not found" }, 404);
    }
    if (path === `/api/notes/${NOTE_ID}`) return jsonResponse({ id: NOTE_ID, title: "Other", body: "" });
    if (path === `/api/notes/${RES_ID}` || path === `/api/notes/${GONE_ID}`) return jsonResponse({ error: "Not found" }, 404);
    if (path === `/api/resources/${GONE_ID}` || path === `/api/resources/${GONE_ID}?view=pdf`) {
      return jsonResponse({ error: "Not found" }, 404);
    }
    return undefined;
  });
});

afterEach(cleanup);

describe("Joplin resource images", () => {
  it.each([
    ["Markdown", `![Cat](:/${RES_ID})`],
    ["Markdown with a title", `![Cat](:/${RES_ID} "A cat")`],
    ["HTML", `<img src=":/${RES_ID}" alt="Cat">`],
    ["an API URL", `![Cat](/api/resources/${RES_ID})`],
  ])("loads %s images through the authenticated API", async (_kind, markdown) => {
    renderMarkdown(markdown);
    await waitFor(() => expect(screen.getByRole("img", { name: "Cat" }).getAttribute("src")).toBe("blob:resource"));
    expect(calls.map((c) => c.path)).toEqual([`/api/resources/${RES_ID}`]);
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ credentials: "include" });
  });

  it("downloads each resource once", async () => {
    renderMarkdown(`![Cat](:/${RES_ID})\n\n![Cat again](:/${RES_ID})`);
    await waitFor(() => expect(screen.getAllByRole("img").every((i) => i.getAttribute("src") === "blob:resource")).toBe(true));
    expect(calls.filter((c) => c.path === `/api/resources/${RES_ID}`)).toHaveLength(1);
  });

  it("shows a placeholder when the image can't be loaded", async () => {
    renderMarkdown(`![Lost](:/${GONE_ID})`);
    expect(await screen.findByText("Image could not be loaded: Lost")).toBeTruthy();
  });

  it("leaves external images alone", () => {
    renderMarkdown("![Logo](https://example.com/logo.png)");
    expect(screen.getByRole("img", { name: "Logo" }).getAttribute("src")).toBe("https://example.com/logo.png");
    expect(calls).toHaveLength(0);
  });
});

describe("links to other notes", () => {
  it.each([
    ["Markdown", `[Other note](:/${NOTE_ID})`],
    ["upper-case Markdown", `[Other note](:/${NOTE_ID.toUpperCase()})`],
    ["HTML", `<a href=":/${NOTE_ID}">Other note</a>`],
  ])("renders %s :/id links as buttons that open the note", async (_kind, markdown) => {
    renderMarkdown(markdown);
    fireEvent.click(screen.getByRole("button", { name: "Other note" }));
    expect(await screen.findByText(`Opened note ${NOTE_ID}`)).toBeTruthy();
  });

  // Regression test for #93 (more cases in MarkdownRenderer.heading-links.test.tsx)
  it("opens :/id#heading links to a heading in another note", async () => {
    renderMarkdown(`[Other note](:/${NOTE_ID}#shopping-list)`);
    fireEvent.click(screen.getByRole("button", { name: "Other note" }));
    expect(await screen.findByText(`Opened note ${NOTE_ID}`)).toBeTruthy();
  });

  it("downloads non-PDF attachments as the old button when the id is not a note", async () => {
    renderMarkdown(`[notes.txt](:/${RES_ID})`);
    expect(document.querySelector("iframe")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "notes.txt" }));
    await waitFor(() => expect(downloads).toEqual(["notes.txt"]));
    expect(screen.queryByText(/Opened note/)).toBeNull();
  });

  it("stays on the page when the linked item no longer exists", async () => {
    renderMarkdown(`[Gone](:/${GONE_ID})`);
    fireEvent.click(screen.getByRole("button", { name: "Gone" }));
    await waitFor(() => expect(calls.some((c) => c.path === `/api/resources/${GONE_ID}`)).toBe(true));
    expect(downloads).toEqual([]);
    expect(screen.getByRole("button", { name: "Gone" })).toBeTruthy();
  });

  it("opens external links in a new tab without opener", () => {
    renderMarkdown("[Joplin](https://joplinapp.org)");
    const link = screen.getByRole("link", { name: "Joplin" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });
});

describe("PDF attachments", () => {
  it.each([
    ["Markdown", `[11042026235350.pdf](:/${RES_ID})`, "11042026235350.pdf", false],
    ["uppercase .PDF", `[REPORT.PDF](:/${RES_ID.toUpperCase()})`, "REPORT.PDF", false],
    ["HTML note", `<a href=":/${RES_ID}">clip.pdf</a>`, "clip.pdf", true],
  ])(
    "renders %s PDF links as a collapsed thumbnail card that expands on click and collapses back",
    async (_kind, content, name, html) => {
      const { destroy } = mockPdfDocument(12, 612, 792);
      const container = renderMarkdown(content, html);

      // Collapsed initially: no iframe, shows skeleton then rendered thumbnail + page count
      expect(container.querySelector("iframe")).toBeNull();
      expect(screen.getByText(name)).toBeTruthy();

      const thumbImg = (await screen.findByRole("img", { name: `${name} — page 1 preview` })) as HTMLImageElement;
      expect(thumbImg.getAttribute("src")).toBe("blob:resource");
      expect(thumbImg.getAttribute("width")).toBe("612");
      expect(thumbImg.getAttribute("height")).toBe("792");
      expect(screen.getByText("12 pages")).toBeTruthy();
      expect(pdfjsMock.GlobalWorkerOptions.workerSrc).toBe("/assets/pdf.worker.min.mjs");
      expect(pdfjsMock.getDocument).toHaveBeenCalledWith(
        expect.objectContaining({ isEvalSupported: false, useWasm: false })
      );
      expect(destroy).toHaveBeenCalled();
      expect(calls.some((c) => c.path === `/api/resources/${RES_ID}?view=pdf`)).toBe(true);

      const openLink = screen.getByRole("link", { name: "Open" });
      expect(openLink.getAttribute("href")).toBe(`/api/resources/${RES_ID}?view=pdf`);
      expect(openLink.getAttribute("target")).toBe("_blank");
      expect(openLink.getAttribute("rel")).toBe("noopener noreferrer");

      // Clicking the thumbnail expands to the inline iframe
      fireEvent.click(thumbImg);
      const iframe = container.querySelector("iframe");
      expect(iframe).not.toBeNull();
      expect(iframe?.getAttribute("src")).toBe(`/api/resources/${RES_ID}?view=pdf`);
      expect(iframe?.getAttribute("title")).toBe(name);
      expect(iframe?.getAttribute("loading")).toBe("lazy");

      // Collapse returns to the thumbnail card
      fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
      expect(container.querySelector("iframe")).toBeNull();
      expect(screen.getByRole("img", { name: `${name} — page 1 preview` })).toBeTruthy();

      // Preview button also expands to the iframe
      fireEvent.click(screen.getByRole("button", { name: "Preview" }));
      expect(container.querySelector("iframe")).not.toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
      expect(container.querySelector("iframe")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Download" }));
      await waitFor(() => expect(downloads).toEqual([name]));
    }
  );

  it("formats singular page count and memoizes thumbnails per resource id", async () => {
    mockPdfDocument(1, 595, 842);
    const { unmount } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <MarkdownRenderer content={`[single.pdf](:/${RES_ID})`} />
        </MemoryRouter>
      </QueryClientProvider>
    );
    await screen.findByRole("img", { name: "single.pdf — page 1 preview" });
    expect(screen.getByText("1 page")).toBeTruthy();
    expect(calls.filter((c) => c.path === `/api/resources/${RES_ID}?view=pdf`)).toHaveLength(1);
    expect(pdfjsMock.getDocument).toHaveBeenCalledTimes(1);
    unmount();

    // Switching back to a note with the same PDF reuses the session cache without re-fetching
    renderMarkdown(`[single.pdf](:/${RES_ID})`);
    expect(screen.getByRole("img", { name: "single.pdf — page 1 preview" }).getAttribute("src")).toBe("blob:resource");
    expect(screen.getByText("1 page")).toBeTruthy();
    expect(calls.filter((c) => c.path === `/api/resources/${RES_ID}?view=pdf`)).toHaveLength(1);
    expect(pdfjsMock.getDocument).toHaveBeenCalledTimes(1);

    // Logout / clearResourceCache() revokes the thumbnail blob URL and forgets the memoized result
    cleanup();
    clearResourceCache();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:resource");
    renderMarkdown(`[single.pdf](:/${RES_ID})`);
    await screen.findByRole("img", { name: "single.pdf — page 1 preview" });
    expect(pdfjsMock.getDocument).toHaveBeenCalledTimes(2);
    expect(calls.filter((c) => c.path === `/api/resources/${RES_ID}?view=pdf`)).toHaveLength(2);
  });

  it("renders the thumbnail and links to a new tab when navigator.pdfViewerEnabled is false", async () => {
    vi.stubGlobal("navigator", { ...navigator, pdfViewerEnabled: false });
    const container = renderMarkdown(`[mobile.pdf](:/${RES_ID})`);
    const thumbImg = await screen.findByRole("img", { name: "mobile.pdf — page 1 preview" });
    expect(screen.getByText("12 pages")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();

    const thumbLink = thumbImg.closest("a");
    expect(thumbLink).not.toBeNull();
    expect(thumbLink?.getAttribute("href")).toBe(`/api/resources/${RES_ID}?view=pdf`);
    expect(thumbLink?.getAttribute("target")).toBe("_blank");
    expect(thumbLink?.getAttribute("rel")).toBe("noopener noreferrer");

    fireEvent.click(thumbLink!);
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("link", { name: "Open" }).getAttribute("href")).toBe(`/api/resources/${RES_ID}?view=pdf`);

    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(downloads).toEqual(["mobile.pdf"]));
  });

  it("falls back to an icon card when PDF parsing fails (corrupt or encrypted)", async () => {
    const destroy = vi.fn(async () => undefined);
    const rejected = Promise.reject(new Error("Invalid PDF structure"));
    rejected.catch(() => undefined);
    pdfjsMock.getDocument.mockReturnValue({ promise: rejected, destroy });

    const container = renderMarkdown(`[encrypted.pdf](:/${RES_ID})`);
    expect(await screen.findByText("PDF attachment")).toBeTruthy();
    expect(screen.getByText("encrypted.pdf")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(destroy).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Preview" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open" }).getAttribute("href")).toBe(`/api/resources/${RES_ID}?view=pdf`);
    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
  });

  it.each([
    ["404 attachment", GONE_ID, "missing.pdf"],
    ["link that points to a note", NOTE_ID, "notes.pdf"],
  ])("falls back to an icon card on %s without throwing", async (_kind, id, name) => {
    const container = renderMarkdown(`[${name}](:/${id})`);
    expect(await screen.findByText("PDF attachment")).toBeTruthy();
    expect(screen.getByText(name)).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("link", { name: "Open" }).getAttribute("href")).toBe(`/api/resources/${id}?view=pdf`);
    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
  });

  it("defers downloading and rendering until the card enters near the viewport", async () => {
    const observers: Array<{ target: Element; callback: IntersectionObserverCallback }> = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        private callback: IntersectionObserverCallback;
        constructor(callback: IntersectionObserverCallback) {
          this.callback = callback;
        }
        observe(target: Element) {
          observers.push({ target, callback: this.callback });
        }
        disconnect() {}
        unobserve() {}
      }
    );

    renderMarkdown(`[first.pdf](:/${RES_ID})\n\n[second.pdf](:/${RES_ID_2})`);
    expect(screen.getByRole("img", { name: "Loading first.pdf" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Loading second.pdf" })).toBeTruthy();
    expect(calls).toHaveLength(0);
    expect(pdfjsMock.getDocument).not.toHaveBeenCalled();

    // Scroll only the first card into view
    observers[0].callback([{ isIntersecting: true, target: observers[0].target } as IntersectionObserverEntry], {} as IntersectionObserver);
    await screen.findByRole("img", { name: "first.pdf — page 1 preview" });
    expect(calls.map((c) => c.path)).toEqual([`/api/resources/${RES_ID}?view=pdf`]);
    expect(screen.getByRole("img", { name: "Loading second.pdf" })).toBeTruthy();
  });

  it("keeps the button when .pdf is not at the end of the label", () => {
    const container = renderMarkdown(`[report.pdf.bak](:/${RES_ID})`);
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("button", { name: "report.pdf.bak" })).toBeTruthy();
  });
});

describe("XSS guard", () => {
  it("drops script tags and inline event handlers", () => {
    const container = renderMarkdown(
      '<script>window.pwned = true</script>\n\n<img src="x" alt="x" onerror="window.pwned = true">\n\n<p onclick="window.pwned = true">Hi</p>'
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML).not.toMatch(/onerror|onclick|pwned/);
    expect((window as { pwned?: boolean }).pwned).toBeUndefined();
  });

  it.each([
    ["a Markdown link", "[Click](javascript:alert(1))"],
    ["an HTML link", '<a href="javascript:alert(1)">Click</a>'],
    ["an obfuscated link", '<a href="JaVaScRiPt&#58;alert(1)">Click</a>'],
    ["a data: link", '<a href="data:text/html,<script>alert(1)</script>">Click</a>'],
  ])("strips javascript: and data: URLs from %s", (_kind, markdown) => {
    const container = renderMarkdown(markdown);
    for (const a of container.querySelectorAll("a")) {
      expect(a.getAttribute("href") ?? "").not.toMatch(/^\s*(javascript|data):/i);
    }
    expect(container.innerHTML).not.toMatch(/javascript:/i);
  });

  it("strips javascript: image sources", () => {
    const container = renderMarkdown('<img src="javascript:alert(1)" alt="bad">');
    expect(container.innerHTML).not.toMatch(/javascript:/i);
  });

  it("removes iframes, objects, forms and styles", () => {
    const container = renderMarkdown(
      '<iframe src="https://evil.example"></iframe><object data="x"></object><form action="https://evil.example"><input name="password"></form><style>body{display:none}</style><div style="position:fixed">x</div>'
    );
    expect(container.querySelector("iframe, object, form, style, [style]")).toBeNull();
  });

  it("drops classes that could restyle the app, but keeps highlight classes", () => {
    const container = renderMarkdown('<div class="fixed inset-0 z-50">overlay</div>\n\n```js\nconst a = 1;\n```');
    expect(screen.getByText("overlay").className).toBe("");
    expect(container.querySelector("code.language-js, code.hljs")).not.toBeNull();
  });

  it("keeps ids from clobbering globals", () => {
    const container = renderMarkdown('<a id="location" name="fetch" href="https://example.com">x</a>');
    const a = container.querySelector("a");
    expect(a?.id === "location" || a?.getAttribute("name") === "fetch").toBe(false);
  });
});

// Regression tests for #104: notes with markup_language: 2 (Web Clipper) are HTML, not Markdown
describe("HTML notes", () => {
  const CLIP = '<div class="clip">\n  <p>Intro</p>\n\n    <p>After blank line, indented</p>\n</div>';

  it("renders indented HTML after a blank line as HTML, not as a code block", () => {
    const container = renderMarkdown(CLIP, true);
    expect(container.querySelector("pre, code")).toBeNull();
    expect(screen.getByText("After blank line, indented").tagName).toBe("P");
    expect(container.textContent).not.toContain("<p>");
  });

  it("shows the same HTML as a code block when it is Markdown", () => {
    const container = renderMarkdown(CLIP);
    expect(container.querySelector("code")?.textContent).toContain("<p>After blank line, indented</p>");
  });

  it("does not apply Markdown syntax inside HTML", () => {
    const container = renderMarkdown("<p>Take the *regional* train, not the _express_. # Not a heading</p>\n\n- not a list", true);
    expect(container.querySelector("em, h1, ul")).toBeNull();
    expect(container.textContent).toContain("*regional*");
    expect(container.textContent).toContain("- not a list");
  });

  it("loads :/id images through the API and opens :/id links", async () => {
    renderMarkdown(`<img src=":/${RES_ID}" alt="Cat">\n\n  <a href=":/${NOTE_ID}">Other note</a>`, true);
    // Loaded through ResourceImage, like images in Markdown notes
    await waitFor(() => expect(calls.map((c) => c.path)).toContain(`/api/resources/${RES_ID}`));
    fireEvent.click(screen.getByRole("button", { name: "Other note" }));
    expect(await screen.findByText(`Opened note ${NOTE_ID}`)).toBeTruthy();
  });

  it("leaves Markdown-style :/id links as text", () => {
    renderMarkdown(`<p>[Other note](:/${NOTE_ID})</p>`, true);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(`[Other note](:/${NOTE_ID})`)).toBeTruthy();
  });

  it("sanitizes like Markdown notes: no scripts, handlers, javascript: URLs, styles or app classes", () => {
    const container = renderMarkdown(
      '<html><head><title>Page</title><style>body{display:none}</style><script>window.pwned = true</script></head>' +
        '<body><img src="x" alt="x" onerror="window.pwned = true"><p onclick="window.pwned = true" style="position:fixed" class="fixed inset-0">Hi</p>' +
        '<a href="javascript:alert(1)">Click</a><iframe src="https://evil.example"></iframe><input type="checkbox" checked></body></html>',
      true
    );
    expect(container.querySelector("script, style, iframe, [style], [onclick], [onerror]")).toBeNull();
    expect(container.innerHTML).not.toMatch(/pwned|javascript:|display:none/i);
    expect(screen.getByText("Hi").className).toBe("");
    expect(container.textContent).not.toContain("Page");
    expect((container.querySelector("input") as HTMLInputElement).disabled).toBe(true);
    expect((window as { pwned?: boolean }).pwned).toBeUndefined();
  });
});
