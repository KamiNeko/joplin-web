import { afterEach, describe, expect, it, vi } from "vitest";
import indexHtml from "../../index.html?raw";
import manifestSource from "../../public/manifest.webmanifest?raw";
import workerSource from "../../public/sw.js?raw";
import { registerServiceWorker } from "./pwa";

const publicFiles = import.meta.glob("../../public/**/*.{png,svg,html}", { query: "?url" });
const pngFiles = import.meta.glob<string>("../../public/**/*.png", { query: "?inline", import: "default", eager: true });

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

/** Width and height from a PNG's IHDR chunk, read from a data: URL */
function pngSize(dataUrl: string): string {
  const bytes = Uint8Array.from(atob(dataUrl.split(",")[1]), (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  return `${view.getUint32(16)}x${view.getUint32(20)}`;
}

describe("web app manifest", () => {
  const manifest = JSON.parse(manifestSource) as { icons: ManifestIcon[]; display: string; start_url: string };

  it("is linked with credentials, so it also loads behind a sign-in proxy", () => {
    expect(indexHtml).toMatch(/<link rel="manifest" href="\/manifest\.webmanifest" crossorigin="use-credentials" \/>/);
    expect(indexHtml).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    expect(manifest.display).toBe("standalone");
  });

  it("lists icons that exist with the declared sizes, including the ones Chrome needs to install", () => {
    for (const icon of manifest.icons) {
      const file = `../../public${icon.src}`;
      expect(Object.keys(publicFiles), icon.src).toContain(file);
      if (icon.type === "image/png") expect(pngSize(pngFiles[file]), icon.src).toBe(icon.sizes);
    }
    const sizes = manifest.icons.filter((icon) => icon.type === "image/png").map((icon) => icon.sizes);
    expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(manifest.icons.some((icon) => icon.purpose === "maskable")).toBe(true);
    expect(pngSize(pngFiles["../../public/apple-touch-icon.png"])).toBe("180x180");
  });
});

describe("registerServiceWorker", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  });

  function stubServiceWorker() {
    const register = vi.fn(async () => ({}));
    Object.defineProperty(navigator, "serviceWorker", { value: { register }, configurable: true });
    return register;
  }

  it("registers /sw.js in production builds once the page has loaded", () => {
    vi.stubEnv("PROD", true);
    const register = stubServiceWorker();
    vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    registerServiceWorker();
    expect(register).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("load"));
    expect(register).toHaveBeenCalledWith("/sw.js");
  });

  it("registers right away when the page has already loaded", () => {
    vi.stubEnv("PROD", true);
    const register = stubServiceWorker();
    vi.spyOn(document, "readyState", "get").mockReturnValue("complete");
    registerServiceWorker();
    expect(register).toHaveBeenCalledWith("/sw.js");
  });

  it("does nothing in development, where it would get in the way of Vite", () => {
    vi.stubEnv("PROD", false);
    const register = stubServiceWorker();
    registerServiceWorker();
    window.dispatchEvent(new Event("load"));
    expect(register).not.toHaveBeenCalled();
  });
});

describe("service worker (public/sw.js)", () => {
  type Listener = (event: unknown) => void;

  /** Runs sw.js against stubbed worker globals; returns its listeners and the stubs */
  function loadWorker(network: (request: unknown) => Promise<Response>) {
    const listeners: Record<string, Listener> = {};
    const offlinePage = new Response("offline");
    const cache = { add: vi.fn(async () => undefined) };
    const caches = {
      open: vi.fn(async () => cache),
      keys: vi.fn(async () => ["joplin-web-offline-v0", "joplin-web-offline-v1", "someone-else"]),
      delete: vi.fn(async () => true),
      match: vi.fn(async () => offlinePage),
    };
    const self = {
      addEventListener: (type: string, listener: Listener) => (listeners[type] = listener),
      skipWaiting: vi.fn(async () => undefined),
    };
    class FakeRequest {
      constructor(
        public url: string,
        public init?: RequestInit
      ) {}
    }
    const fetchStub = vi.fn(network);
    new Function("self", "caches", "fetch", "Request", workerSource)(self, caches, fetchStub, FakeRequest);
    return { listeners, cache, caches, self, fetchStub, offlinePage };
  }

  /** Dispatches a fetch event; returns what the worker answered with, or undefined if it let it through */
  async function dispatchFetch(listener: Listener, url: string, mode: RequestMode) {
    let answer: Promise<Response> | undefined;
    listener({ request: { url, mode }, respondWith: (response: Promise<Response>) => (answer = response) });
    return answer && (await answer);
  }

  async function dispatchLifecycle(listener: Listener) {
    let done: Promise<unknown> = Promise.resolve();
    listener({ waitUntil: (promise: Promise<unknown>) => (done = promise) });
    await done;
  }

  it("caches only the offline page on install and removes its own outdated caches", async () => {
    const { listeners, cache, caches, self } = loadWorker(async () => new Response("page"));
    await dispatchLifecycle(listeners.install);
    expect(cache.add).toHaveBeenCalledWith(expect.objectContaining({ url: "/offline.html" }));
    expect(self.skipWaiting).toHaveBeenCalled();
    await dispatchLifecycle(listeners.activate);
    expect(caches.delete.mock.calls).toEqual([["joplin-web-offline-v0"]]);
  });

  it("loads pages from the network, so a sign-in proxy's redirect reaches the browser", async () => {
    const redirect = Object.defineProperty(Response.error(), "type", { value: "opaqueredirect" });
    const { listeners, caches } = loadWorker(async () => redirect);
    expect(await dispatchFetch(listeners.fetch, "https://notes.example.com/notes/abc", "navigate")).toBe(redirect);
    expect(caches.match).not.toHaveBeenCalled();
  });

  it("shows the offline page when a page can't be loaded", async () => {
    const { listeners, offlinePage } = loadWorker(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await dispatchFetch(listeners.fetch, "https://notes.example.com/notes", "navigate")).toBe(offlinePage);
  });

  it("leaves API requests, attachments and other requests alone", async () => {
    const { listeners, fetchStub } = loadWorker(async () => new Response("page"));
    expect(await dispatchFetch(listeners.fetch, "https://notes.example.com/api/resources/x", "navigate")).toBeUndefined();
    expect(await dispatchFetch(listeners.fetch, "https://notes.example.com/api/notes", "cors")).toBeUndefined();
    expect(await dispatchFetch(listeners.fetch, "https://notes.example.com/assets/index.js", "cors")).toBeUndefined();
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
