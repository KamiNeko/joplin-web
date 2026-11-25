import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { MarkdownRenderer } from "./MarkdownRenderer";

function renderMd(content: string) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <MarkdownRenderer content={content} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MarkdownRenderer workspace extensions", () => {
  it("renders [!NOTE], [!TIP], [!WARNING], [!IMPORTANT], and [!CAUTION] callouts while keeping normal blockquotes", () => {
    const md = [
      "> [!NOTE]",
      "> Helpful note body",
      "",
      "> [!TIP] Pro tip inside quote",
      "",
      "> [!WARNING]",
      "> Watch out",
      "",
      "> [!IMPORTANT]",
      "> Must read",
      "",
      "> [!CAUTION]",
      "> Danger zone",
      "",
      "> Plain quote here",
    ].join("\n");

    const { container } = renderMd(md);

    expect(container.querySelector('[data-callout="note"]')?.textContent).toContain("Helpful note body");
    expect(container.querySelector('[data-callout="tip"]')?.textContent).toContain("Pro tip inside quote");
    expect(container.querySelector('[data-callout="warning"]')?.textContent).toContain("Watch out");
    expect(container.querySelector('[data-callout="important"]')?.textContent).toContain("Must read");
    expect(container.querySelector('[data-callout="caution"]')?.textContent).toContain("Danger zone");

    const plainQuote = container.querySelector("blockquote");
    expect(plainQuote?.textContent).toContain("Plain quote here");
    expect(plainQuote?.hasAttribute("data-callout")).toBe(false);
  });

  it("renders collapsible <details> and <summary> elements cleanly after sanitization", () => {
    const md = "<details open>\n<summary>Architecture notes</summary>\n\nInner detail text\n\n</details>";
    const { container } = renderMd(md);

    const details = container.querySelector("details");
    const summary = container.querySelector("summary");
    expect(details).not.toBeNull();
    expect(details?.hasAttribute("open")).toBe(true);
    expect(summary?.textContent).toBe("Architecture notes");
    expect(details?.textContent).toContain("Inner detail text");
  });

  it("renders inline audio and video players for audio/video :/id links", () => {
    const audioId = "11111111111111111111111111111111";
    const videoId = "22222222222222222222222222222222";
    const md = `[standup.webm](:/${audioId})\n\n[demo.mp4](:/${videoId})`;

    const { container } = renderMd(md);
    const audio = container.querySelector("audio");
    const video = container.querySelector("video");
    expect(audio?.getAttribute("src")).toBe(`/api/resources/${audioId}`);
    expect(audio?.hasAttribute("controls")).toBe(true);
    expect(video?.getAttribute("src")).toBe(`/api/resources/${videoId}`);
    expect(video?.hasAttribute("controls")).toBe(true);
  });

  it("opens an image lightbox on click and downloads resource images", async () => {
    const imgId = "33333333333333333333333333333333";
    const fetchMock = vi.fn(async () => new Response(new Blob(["imgdata"], { type: "image/png" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    if (!URL.createObjectURL) {
      Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:mock"), configurable: true });
    } else {
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
    }
    if (!URL.revokeObjectURL) {
      Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
    } else {
      vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    }

    renderMd(`![Architecture diagram](:/${imgId})`);

    const img = await screen.findByAltText("Architecture diagram");
    fireEvent.click(img);

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Architecture diagram");
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/resources/${imgId}`, expect.anything()));
  });
});
