import { beforeEach, expect, it, vi } from "vitest";
import { mockFetch } from "@/test/fetch-mock";
import { getPdfThumbnail } from "./pdf-thumbnail";

const pdfjs = vi.hoisted(() => ({
  GlobalWorkerOptions: { workerSrc: "" },
  VerbosityLevel: { ERRORS: 0 },
  getDocument: vi.fn(),
}));
vi.mock("pdfjs-dist", () => pdfjs);
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "/assets/pdf.worker.min.mjs" }));
vi.mock("pdfjs-dist/wasm/jbig2_nowasm_fallback.js?url", () => ({ default: "/assets/pdfjs/jbig2_nowasm_fallback.js" }));
vi.mock("pdfjs-dist/wasm/openjpeg_nowasm_fallback.js?url", () => ({
  default: "/assets/pdfjs/openjpeg_nowasm_fallback.js",
}));

/** Each getDocument call waits until the test resolves its document */
const openDocs: Array<() => void> = [];

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:page1");
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => ({ fillStyle: "", fillRect: vi.fn() }) as unknown as RenderingContext
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(new Blob(["png"])));
  mockFetch(() => new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46])));
  pdfjs.getDocument.mockImplementation(() => ({
    promise: new Promise((resolve) =>
      openDocs.push(() =>
        resolve({
          numPages: 3,
          cleanup: async () => undefined,
          getPage: async () => ({
            getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale }),
            render: () => ({ promise: Promise.resolve() }),
          }),
        })
      )
    ),
    destroy: async () => undefined,
  }));
});

it("renders with the no-WASM decoders and at most two PDFs at a time", async () => {
  const thumbs = ["a", "b", "c"].map((c) => getPdfThumbnail(c.repeat(32)));
  await vi.waitFor(() => expect(pdfjs.getDocument).toHaveBeenCalledTimes(2));
  expect(pdfjs.getDocument).toHaveBeenCalledWith(
    expect.objectContaining({
      isEvalSupported: false,
      useWasm: false,
      wasmUrl: `${window.location.origin}/assets/pdfjs/`,
    })
  );

  openDocs.shift()!();
  await vi.waitFor(() => expect(pdfjs.getDocument).toHaveBeenCalledTimes(3));
  openDocs.splice(0).forEach((open) => open());
  expect(await Promise.all(thumbs)).toEqual(
    Array(3).fill({ url: "blob:page1", pageCount: 3, width: 612, height: 792 })
  );
});
