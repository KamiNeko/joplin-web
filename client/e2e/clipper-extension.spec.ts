import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { demoId, signIn, uniqueWord } from "./helpers";

const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../extension");
const EXPECTED_EXTENSION_ID = "nlplgmnmaigjhfbhkbmcpfcdnppaklco";

// Minimal valid 1x1 PNG
const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex"
);

// 1x1 transparent GIF placeholder used for lazy-loaded image testing
const PLACEHOLDER_GIF_DATA_URI = "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=";

// Lightweight browser DOM typings for page.evaluate() (tsconfig.node.json excludes DOM lib)
interface DomRectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}
interface DomElementLike {
  shadowRoot: DomRootLike | null;
  classList: { contains(c: string): boolean };
  getBoundingClientRect(): DomRectLike;
}
interface DomRootLike {
  querySelector(sel: string): DomElementLike | null;
  querySelectorAll(sel: string): ArrayLike<DomElementLike>;
}
interface BrowserGlobalLike {
  document: DomRootLike & {
    getElementById(id: string): DomElementLike | null;
    createRange(): { selectNodeContents(n: unknown): void };
  };
  window: {
    devicePixelRatio: number;
    getComputedStyle(el: DomElementLike): { backgroundColor: string; borderTopStyle: string };
    getSelection(): { removeAllRanges(): void; addRange(r: unknown): void } | null;
    addEventListener(
      type: string,
      fn: (ev: { violatedDirective: string; blockedURI: string }) => void
    ): void;
  };
  __cspViolations?: string[];
}

function buildArticleHtml({ includeImages = true } = {}): string {
  const heroImg = includeImages
    ? `<img src="/hero.png" alt="Hero Illustration" width="64" height="64" />`
    : "";
  const lazyImg = includeImages
    ? `<img src="${PLACEHOLDER_GIF_DATA_URI}" data-src="/lazy.png" alt="Lazy Diagram" width="64" height="64" />`
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Fixture Article Title</title>
    <meta property="og:title" content="Fixture Article Title" />
    <meta property="og:site_name" content="Fixture Press" />
    <meta name="description" content="A concise bookmark summary for the fixture article." />
    <meta property="og:image" content="/og.png" />
    <link rel="stylesheet" href="/fixture.css" />
  </head>
  <body>
    <header class="site-header"><nav><a id="nav-link" href="/home">Navigation</a></nav></header>
    <main class="page-main">
      <article id="main-article">
        <h1>Fixture Article Title</h1>
        <p class="byline">By Ada Lovelace</p>
        <p id="lead-para">
          This is a detailed lead paragraph about self-hosted note taking and browser web clipping.
          It contains enough prose so Mozilla Readability clearly recognizes this article block as
          the primary readable content of the page.
        </p>
        <div id="selectable-block">
          <p>Selected highlight paragraph with an embedded hero illustration below.</p>
          ${heroImg}
        </div>
        <p id="middle-para">
          A second substantial paragraph ensures that Readability keeps the entire article structure,
          including the lazy-loaded diagram that follows immediately after this sentence.
        </p>
        <p id="last-article-para">
          Final concluding article paragraph with the lazy-loaded diagram right below it.
          ${lazyImg}
        </p>
      </article>

      <div class="comments">
        <p id="outside-para">
          Outside appendix paragraph sitting below the article element for drag-to-expand testing.
        </p>
      </div>

      <section id="pick-section">
        Standalone sidebar section for click-to-pick verification.
      </section>

      <div class="hidden-secret">Secret Hidden Text</div>
      <form action="/submit"><input type="text" name="secret" value="ignored" /><button type="submit">Submit</button></form>
    </main>
  </body>
</html>`;
}

const FIXTURE_CSS = `
  body {
    margin: 0;
    padding: 0;
    font-family: system-ui, -apple-system, sans-serif;
    line-height: 1.6;
    background: #f8fafc;
    color: #0f172a;
  }
  .site-header {
    padding: 12px 24px;
    background: #e2e8f0;
  }
  .page-main {
    max-width: 720px;
    margin: 24px auto;
    padding: 0 24px 60px;
  }
  article {
    background: #ffffff;
    padding: 20px 24px;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
  }
  article p, article div {
    margin: 12px 0;
  }
  .comments {
    margin-top: 16px;
    padding: 16px 24px;
    background: #fff7ed;
    border: 1px solid #fed7aa;
    border-radius: 8px;
  }
  #pick-section {
    margin-top: 16px;
    padding: 20px 24px;
    background: #eff6ff;
    border: 1px solid #bfdbfe;
    border-radius: 8px;
  }
  .hidden-secret {
    display: none;
  }
`;

async function startFixtureServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const reqPath = (req.url || "/").split("?")[0];
    if (reqPath === "/hero.png" || reqPath === "/lazy.png" || reqPath === "/og.png") {
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
      res.end(TINY_PNG);
      return;
    }
    if (reqPath === "/fixture.css") {
      res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
      res.end(FIXTURE_CSS);
      return;
    }
    if (reqPath === "/article") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(buildArticleHtml({ includeImages: true }));
      return;
    }
    if (reqPath === "/strict-csp") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; style-src 'self'",
      });
      res.end(buildArticleHtml({ includeImages: false }));
      return;
    }
    if (reqPath === "/heading-above-content") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Designing Resilient Web Clippers | Engineering Blog</title>
    <link rel="stylesheet" href="/fixture.css" />
  </head>
  <body>
    <header class="site-header"><nav><a href="/">Home</a></nav></header>
    <main class="page-main">
      <div id="post-wrapper">
        <header><h1 id="post-h1">Designing Resilient Web Clippers</h1></header>
        <p class="byline" id="post-byline">Nov. 28, 2024 · By Ada Lovelace</p>
        <div id="post-content">
          <p>
            First long prose paragraph inside a dedicated post content container that sits below the
            separate headline header and byline metadata block.
          </p>
          <p>
            Second long prose paragraph giving Readability a high content score on the inner content
            div while excluding the outer headline and publication date.
          </p>
          <p>
            Third long prose paragraph confirming that the default detected clip region expands up
            to include the matching headline and byline automatically.
          </p>
        </div>
      </div>
    </main>
  </body>
</html>`);
      return;
    }
    if (reqPath === "/intro-before-readability") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Picture Element Reference - HTML | Docs</title>
    <link rel="stylesheet" href="/fixture.css" />
  </head>
  <body>
    <header class="site-header"><nav><a href="/">Docs</a></nav></header>
    <main id="doc-main" class="page-main">
      <div id="doc-header">
        <h1 id="doc-h1">Picture Element Reference</h1>
        <p id="doc-intro">
          Essential introductory summary paragraph explaining the element before the interactive examples begin.
        </p>
      </div>
      <aside id="doc-toc">
        <nav><p>SIDEBAR_TOC_MARKER</p><a href="#try">Try it</a></nav>
      </aside>
      <div id="doc-body">
        <section>
          <h2 id="try">Try it</h2>
          <p>
            Detailed first body paragraph with plenty of words so Mozilla Readability selects the
            doc-body container as its primary candidate and drops the header intro block above the sidebar.
          </p>
          <p>
            Detailed second body paragraph continuing the technical reference documentation with
            concrete responsive image art direction guidance and browser selection rules.
          </p>
          <p>
            Detailed third body paragraph describing fallback image sources, media conditions, and
            format negotiation across modern rendering engines.
          </p>
        </section>
      </div>
    </main>
  </body>
</html>`);
      return;
    }
    if (reqPath === "/site-header-h1") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Quarterly Architecture Review — Acme Engineering Notes</title>
    <link rel="stylesheet" href="/fixture.css" />
  </head>
  <body>
    <header class="site-header" id="site-header">
      <h1 id="brand-h1">Acme Engineering Notes</h1>
      <nav><a href="/">Home</a> <a href="/archive">Archive</a></nav>
    </header>
    <main class="page-main">
      <div id="entry-body">
        <h2>Quarterly Architecture Review</h2>
        <p>
          First substantial paragraph describing our quarterly architecture review, storage engine
          benchmarks, and replication latency targets across every cluster.
        </p>
        <p>
          Second substantial paragraph covering failure drills, schema migration safeguards, and
          automated rollback verification in staging environments.
        </p>
        <p>
          Third substantial paragraph summarizing next quarter milestones and operational ownership
          across the platform engineering team.
        </p>
      </div>
    </main>
  </body>
</html>`);
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function launchExtensionContext(opts?: { deviceScaleFactor?: number }): Promise<{
  context: BrowserContext;
  extensionId: string;
  serviceWorker: Worker;
  cleanup: () => Promise<void>;
}> {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), "joplin-clipper-e2e-"));
  const executablePath = process.env.E2E_EXECUTABLE_PATH;
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...(executablePath ? { executablePath } : { channel: "chromium" }),
    headless: true,
    viewport: { width: 1280, height: 800 },
    ...(opts?.deviceScaleFactor ? { deviceScaleFactor: opts.deviceScaleFactor } : {}),
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
    ],
  });

  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent("serviceworker");
  }
  const extensionId = new URL(serviceWorker.url()).host;

  return {
    context,
    extensionId,
    serviceWorker,
    cleanup: async () => {
      await context.close();
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

async function getOrOpenOptionsPage(context: BrowserContext, extensionId: string) {
  const optionsUrl = `chrome-extension://${extensionId}/options.html`;
  let page = context.pages().find((p) => p.url() === optionsUrl);
  if (!page) {
    page =
      (await context
        .waitForEvent("page", {
          predicate: (p) => p.url() === optionsUrl,
          timeout: 2000,
        })
        .catch(() => null)) ?? undefined;
  }
  if (!page) {
    page = await context.newPage();
    await page.goto(optionsUrl);
  } else {
    await page.waitForLoadState("domcontentloaded");
  }
  return page;
}

async function findTabIdByUrl(serviceWorker: Worker, targetUrl: string): Promise<number> {
  const tabId = await serviceWorker.evaluate(async (url) => {
    const api = (
      globalThis as unknown as {
        chrome: { tabs: { query: (q: Record<string, unknown>) => Promise<Array<{ id?: number; url?: string }>> } };
      }
    ).chrome;
    const tabs = await api.tabs.query({});
    const found = tabs.find((t) => t.url === url);
    return found?.id ?? null;
  }, targetUrl);
  expect(tabId).not.toBeNull();
  return tabId!;
}

interface ClippedNoteResponse {
  id: string;
  title: string;
  body: string;
  parentId: string;
  markupLanguage: number;
  tags: Array<{ id: string; title: string }>;
}

async function fetchNote(appPage: Page, noteId: string): Promise<ClippedNoteResponse> {
  return appPage.evaluate(async (id) => {
    const res = await fetch(`/api/notes/${id}`, { credentials: "include" });
    if (!res.ok) throw new Error(`GET /api/notes/${id} failed: ${res.status}`);
    return (await res.json()) as ClippedNoteResponse;
  }, noteId);
}

async function fetchResourceWithDimensions(appPage: Page, resId: string) {
  return appPage.evaluate(async (id) => {
    const res = await fetch(`/api/resources/${id}`, { credentials: "include" });
    const buf = await res.arrayBuffer();
    const view = new DataView(buf);
    let pngWidth = 0;
    let pngHeight = 0;
    if (
      buf.byteLength >= 24 &&
      view.getUint32(0, false) === 0x89504e47 &&
      view.getUint32(4, false) === 0x0d0a1a0a
    ) {
      pngWidth = view.getUint32(16, false);
      pngHeight = view.getUint32(20, false);
    }
    return {
      status: res.status,
      contentType: res.headers.get("content-type"),
      size: buf.byteLength,
      pngWidth,
      pngHeight,
    };
  }, resId);
}

async function cleanupDemoResources(
  appPage: Page,
  noteIds: string[],
  resourceIds: string[],
  tagNames: Iterable<string>
) {
  await appPage.evaluate(
    async ({ nIds, rIds, tNames }) => {
      for (const id of nIds) {
        await fetch(`/api/notes/${id}`, { method: "DELETE", credentials: "include" }).catch(() => {});
        await fetch(`/api/notes/${id}?permanent=true`, { method: "DELETE", credentials: "include" }).catch(() => {});
      }
      for (const id of rIds) {
        await fetch(`/api/resources/${id}`, { method: "DELETE", credentials: "include" }).catch(() => {});
      }
      const tagsRes = await fetch("/api/tags", { credentials: "include" }).catch(() => null);
      if (tagsRes && tagsRes.ok) {
        const allTags = (await tagsRes.json()) as Array<{ id: string; title: string }>;
        const wanted = new Set(tNames);
        for (const tag of allTags) {
          if (wanted.has(tag.title)) {
            await fetch(`/api/tags/${tag.id}`, { method: "DELETE", credentials: "include" }).catch(() => {});
          }
        }
      }
    },
    {
      nIds: noteIds,
      rIds: Array.from(new Set(resourceIds)),
      tNames: Array.from(tagNames),
    }
  );
}

async function configureSignedInExtension(
  context: BrowserContext,
  extensionId: string,
  serverUrl: string
) {
  const appPage = await context.newPage();
  await signIn(appPage, `${serverUrl}/login`);

  const optionsPage = await getOrOpenOptionsPage(context, extensionId);
  await optionsPage.locator("#server-url").fill(serverUrl);
  await optionsPage.locator("#save-btn").click();
  await expect(optionsPage.locator("#status-banner")).toContainText("Saved server URL");
  await optionsPage.locator("#test-btn").click();
  await expect(optionsPage.locator("#status-banner")).toContainText(/Signed in/i);

  return appPage;
}

async function openPanelForTab(context: BrowserContext, extensionId: string, tabId: number) {
  const p = await context.newPage();
  await p.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=${tabId}&noAutoOpen=1`);
  await expect(p.locator("#form-view")).toBeVisible();
  return p;
}

async function extractNoteIdFromOpenLink(panel: Page) {
  await expect(panel.locator("#success-view")).toBeVisible({ timeout: 20_000 });
  const href = await panel.locator("#open-note-link").getAttribute("href");
  expect(href).toMatch(/\/notes\/[0-9a-f]{32}$/);
  return href!.split("/notes/")[1];
}

async function getOverlayBoxRect(page: Page) {
  return page.evaluate(() => {
    const g = globalThis as unknown as BrowserGlobalLike;
    const host = g.document.getElementById("joplin-clipper-overlay-host");
    if (!host || !host.shadowRoot) return null;
    const box = host.shadowRoot.querySelector(".box");
    if (!box || box.classList.contains("hidden")) return null;
    const r = box.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  });
}

async function getDimmingState(page: Page) {
  return page.evaluate(() => {
    const g = globalThis as unknown as BrowserGlobalLike;
    const host = g.document.getElementById("joplin-clipper-overlay-host");
    if (!host || !host.shadowRoot) return null;
    const slabs = Array.from(host.shadowRoot.querySelectorAll(".dim-slab"));
    const visibleSlabs = slabs.filter((s) => {
      const r = s.getBoundingClientRect();
      return !s.classList.contains("hidden") && r.width > 0 && r.height > 0;
    });
    const bg = visibleSlabs[0] ? g.window.getComputedStyle(visibleSlabs[0]).backgroundColor : "";
    const box = host.shadowRoot.querySelector(".box");
    const borderStyle = box ? g.window.getComputedStyle(box).borderTopStyle : "";
    return { visibleSlabCount: visibleSlabs.length, bg, borderStyle };
  });
}

async function assertOverlayAndTempAttrsCleaned(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const g = globalThis as unknown as BrowserGlobalLike;
          return {
            hasHost: Boolean(g.document.getElementById("joplin-clipper-overlay-host")),
            tempAttrCount: g.document.querySelectorAll("[data-joplin-clip-id]").length,
          };
        }),
      { timeout: 5_000 }
    )
    .toEqual({ hasHost: false, tempAttrCount: 0 });
}

test.describe("Clip to Joplin Web browser extension", () => {
  let fixture: { url: string; close: () => Promise<void> };

  test.beforeAll(async () => {
    fixture = await startFixtureServer();
  });

  test.afterAll(async () => {
    await fixture.close();
  });

  test("signed-out side panel prompts the user to sign in and options test reports signed out", async ({
    baseURL,
  }) => {
    const serverUrl = baseURL!;
    const { context, extensionId, cleanup } = await launchExtensionContext();
    try {
      expect(extensionId).toBe(EXPECTED_EXTENSION_ID);

      const optionsPage = await getOrOpenOptionsPage(context, extensionId);
      await optionsPage.locator("#server-url").fill(serverUrl);
      await optionsPage.locator("#test-btn").click();
      await expect(optionsPage.locator("#status-banner")).toContainText(/Not signed in/i);

      const panelPage = await context.newPage();
      await panelPage.goto(`chrome-extension://${extensionId}/sidepanel.html?noAutoOpen=1`);
      await expect(panelPage.getByRole("button", { name: "Sign in to Joplin Web" })).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test("clips article, selection, full page, screenshot, and bookmark with :/id image attachments", async ({
    baseURL,
  }) => {
    const serverUrl = baseURL!;
    const { context, extensionId, serviceWorker, cleanup } = await launchExtensionContext();
    try {
      expect(extensionId).toBe(EXPECTED_EXTENSION_ID);
      const appPage = await configureSignedInExtension(context, extensionId, serverUrl);

      const fixtureUrl = `${fixture.url}/article`;
      const fixturePage = await context.newPage();
      await fixturePage.goto(fixtureUrl, { waitUntil: "load" });
      await expect(fixturePage.locator("h1")).toHaveText("Fixture Article Title");
      const fixtureTabId = await findTabIdByUrl(serviceWorker, fixtureUrl);

      const runTag = uniqueWord("ext");
      const createdNoteIds: string[] = [];
      const createdResourceIds: string[] = [];
      const createdTagNames = new Set<string>([
        `${runTag}-art`,
        `${runTag}-sel`,
        `${runTag}-full`,
        `${runTag}-shot`,
        `${runTag}-bm`,
      ]);

      try {
        // --- Mode 1: Article ---
        {
          const panel = await openPanelForTab(context, extensionId, fixtureTabId);
          await expect(panel.locator('button[data-mode="selection"]')).toBeDisabled();
          await panel.locator('button[data-mode="article"]').click();
          await expect(panel.locator("#selection-summary")).toContainText(/words · 2 images/);

          const title = `Article ${runTag}`;
          await panel.locator("#clip-title").fill(title);
          await panel.locator("#clip-notebook").selectOption(demoId("nb-work"));
          await panel.locator("#clip-tag-input").fill("plan");
          await panel.locator("#tag-suggestions button", { hasText: "planning" }).click();
          await panel.locator("#clip-tag-input").fill(`${runTag}-art`);
          await panel.locator("#save-btn").click();

          const noteId = await extractNoteIdFromOpenLink(panel);
          createdNoteIds.push(noteId);
          await expect(panel.locator("#success-message")).toContainText("Work");
          await assertOverlayAndTempAttrsCleaned(fixturePage);
          await panel.close();

          const note = await fetchNote(appPage, noteId);
          expect(note.title).toBe(title);
          expect(note.parentId).toBe(demoId("nb-work"));
          expect(note.markupLanguage).toBe(1);
          expect(note.tags.map((t) => t.title)).toEqual(
            expect.arrayContaining(["planning", `${runTag}-art`])
          );
          const imgIds = [...note.body.matchAll(/!\[[^\]]*\]\(:\/([0-9a-f]{32})\)/g)].map((m) => m[1]);
          expect(imgIds.length).toBe(2);
          createdResourceIds.push(...imgIds);
          expect(note.body).not.toContain("/hero.png");
          expect(note.body).not.toContain("/lazy.png");
          expect(note.body).not.toContain("Outside appendix paragraph");
          for (const id of imgIds) {
            const resource = await fetchResourceWithDimensions(appPage, id);
            expect(resource.status).toBe(200);
            expect(resource.contentType).toBe("image/png");
            expect(resource.size).toBe(TINY_PNG.length);
          }
        }

        // --- Mode 2: Selection ---
        {
          await fixturePage.evaluate(() => {
            const g = globalThis as unknown as BrowserGlobalLike;
            const target = g.document.getElementById("selectable-block");
            const range = g.document.createRange();
            range.selectNodeContents(target);
            const sel = g.window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(range);
          });

          const panel = await openPanelForTab(context, extensionId, fixtureTabId);
          await expect(panel.locator('button[data-mode="selection"]')).toBeEnabled();
          await panel.locator('button[data-mode="selection"]').click();
          const title = `Selection ${runTag}`;
          await panel.locator("#clip-title").fill(title);
          await panel.locator("#clip-tag-input").fill(`${runTag}-sel`);
          await panel.locator("#save-btn").click();

          const noteId = await extractNoteIdFromOpenLink(panel);
          createdNoteIds.push(noteId);
          await assertOverlayAndTempAttrsCleaned(fixturePage);
          await panel.close();

          const note = await fetchNote(appPage, noteId);
          expect(note.title).toBe(title);
          expect(note.markupLanguage).toBe(1);
          expect(note.body).toContain("Selected highlight paragraph");
          expect(note.tags.map((t) => t.title)).toContain(`${runTag}-sel`);
          const selMatch = /!\[Hero Illustration\]\(:\/([0-9a-f]{32})\)/.exec(note.body);
          expect(selMatch).not.toBeNull();
          createdResourceIds.push(selMatch![1]);
        }

        // --- Mode 3: Full page (HTML note) ---
        {
          const panel = await openPanelForTab(context, extensionId, fixtureTabId);
          await panel.locator('button[data-mode="fullpage"]').click();
          await assertOverlayAndTempAttrsCleaned(fixturePage);
          const title = `FullPage ${runTag}`;
          await panel.locator("#clip-title").fill(title);
          await panel.locator("#clip-tag-input").fill(`${runTag}-full`);
          await panel.locator("#save-btn").click();

          const noteId = await extractNoteIdFromOpenLink(panel);
          createdNoteIds.push(noteId);
          await panel.close();

          const note = await fetchNote(appPage, noteId);
          expect(note.title).toBe(title);
          expect(note.markupLanguage).toBe(2);
          expect(note.tags.map((t) => t.title)).toContain(`${runTag}-full`);
          const fullIds = [...note.body.matchAll(/src=":\/([0-9a-f]{32})"/g)].map((m) => m[1]);
          expect(fullIds.length).toBeGreaterThanOrEqual(2);
          createdResourceIds.push(...fullIds);
          expect(note.body).not.toMatch(/<script|<form/i);
          expect(note.body).not.toContain("Secret Hidden Text");
        }

        // --- Mode 4: Screenshot (default full viewport) ---
        {
          const panel = await openPanelForTab(context, extensionId, fixtureTabId);
          await panel.locator('button[data-mode="screenshot"]').click();
          const title = `Screenshot ${runTag}`;
          await panel.locator("#clip-title").fill(title);
          await panel.locator("#clip-tag-input").fill(`${runTag}-shot`);
          await panel.locator("#save-btn").click();

          const noteId = await extractNoteIdFromOpenLink(panel);
          createdNoteIds.push(noteId);
          await assertOverlayAndTempAttrsCleaned(fixturePage);
          await panel.close();

          const note = await fetchNote(appPage, noteId);
          expect(note.title).toBe(title);
          expect(note.markupLanguage).toBe(1);
          expect(note.body).toContain(fixtureUrl);
          expect(note.tags.map((t) => t.title)).toContain(`${runTag}-shot`);
          const shotMatch = /!\[[^\]]*\]\(:\/([0-9a-f]{32})\)/.exec(note.body);
          expect(shotMatch).not.toBeNull();
          createdResourceIds.push(shotMatch![1]);
          const shotRes = await fetchResourceWithDimensions(appPage, shotMatch![1]);
          expect(shotRes.status).toBe(200);
          expect(shotRes.contentType).toBe("image/png");
          expect(shotRes.size).toBeGreaterThan(100);
        }

        // --- Mode 5: Bookmark ---
        {
          const panel = await openPanelForTab(context, extensionId, fixtureTabId);
          await panel.locator('button[data-mode="bookmark"]').click();
          const title = `Bookmark ${runTag}`;
          await panel.locator("#clip-title").fill(title);
          await panel.locator("#clip-tag-input").fill(`${runTag}-bm`);
          await panel.locator("#save-btn").click();

          const noteId = await extractNoteIdFromOpenLink(panel);
          createdNoteIds.push(noteId);
          await panel.close();

          const note = await fetchNote(appPage, noteId);
          expect(note.title).toBe(title);
          expect(note.markupLanguage).toBe(1);
          expect(note.body).toContain("A concise bookmark summary for the fixture article.");
          expect(note.body).toContain(fixtureUrl);
          expect(note.tags.map((t) => t.title)).toContain(`${runTag}-bm`);
          const ogMatch = /!\[[^\]]*\]\(:\/([0-9a-f]{32})\)/.exec(note.body);
          expect(ogMatch).not.toBeNull();
          createdResourceIds.push(ogMatch![1]);
          const ogRes = await fetchResourceWithDimensions(appPage, ogMatch![1]);
          expect(ogRes.status).toBe(200);
          expect(ogRes.contentType).toBe("image/png");
        }
      } finally {
        await cleanupDemoResources(appPage, createdNoteIds, createdResourceIds, createdTagNames);
      }
    } finally {
      await cleanup();
    }
  });

  test("article overlay matches article rect, supports drag-to-expand/exclude, +/-, click-to-pick, and cleans up on close", async ({
    baseURL,
  }) => {
    const serverUrl = baseURL!;
    const { context, extensionId, serviceWorker, cleanup } = await launchExtensionContext();
    try {
      const appPage = await configureSignedInExtension(context, extensionId, serverUrl);
      const fixtureUrl = `${fixture.url}/article`;
      const fixturePage = await context.newPage();
      await fixturePage.goto(fixtureUrl, { waitUntil: "load" });
      const fixtureTabId = await findTabIdByUrl(serviceWorker, fixtureUrl);

      const runTag = uniqueWord("ovl");
      const createdNoteIds: string[] = [];
      const createdResourceIds: string[] = [];

      try {
        // 1. Open panel in Article mode -> overlay matches <article> rect and dims the rest of the page
        const panel = await openPanelForTab(context, extensionId, fixtureTabId);
        await panel.locator('button[data-mode="article"]').click();
        await expect(panel.locator("#selection-summary")).toBeVisible();
        await expect(panel.locator("#selection-summary")).toContainText(/~\d+ words · 2 images/);

        await fixturePage.bringToFront();
        await expect.poll(() => getOverlayBoxRect(fixturePage)).not.toBeNull();

        const articleRect = await fixturePage.locator("#main-article").boundingBox();
        const overlayRect = await getOverlayBoxRect(fixturePage);
        expect(articleRect).not.toBeNull();
        expect(overlayRect).not.toBeNull();
        expect(Math.abs(overlayRect!.left - articleRect!.x)).toBeLessThanOrEqual(4);
        expect(Math.abs(overlayRect!.top - articleRect!.y)).toBeLessThanOrEqual(4);
        expect(Math.abs(overlayRect!.width - articleRect!.width)).toBeLessThanOrEqual(4);
        expect(Math.abs(overlayRect!.height - articleRect!.height)).toBeLessThanOrEqual(4);

        const dimming = await getDimmingState(fixturePage);
        expect(dimming).not.toBeNull();
        expect(dimming!.visibleSlabCount).toBeGreaterThanOrEqual(2);
        expect(dimming!.bg).toContain("rgba(15, 23, 42, 0.48)");

        // No temporary data-joplin-clip-id attributes left on live DOM even while overlay is open
        const tempCountWhileOpen = await fixturePage.evaluate(() => {
          const g = globalThis as unknown as BrowserGlobalLike;
          return g.document.querySelectorAll("[data-joplin-clip-id]").length;
        });
        expect(tempCountWhileOpen).toBe(0);

        // 2. "-" then "+" returns to the exact same element (<article>)
        const shrinkBtn = fixturePage.locator('#joplin-clipper-overlay-host >> button[data-action="shrink"]');
        const expandBtn = fixturePage.locator('#joplin-clipper-overlay-host >> button[data-action="expand"]');
        await shrinkBtn.click();
        const shrunkRect = await getOverlayBoxRect(fixturePage);
        expect(shrunkRect).not.toBeNull();
        expect(shrunkRect!.height).toBeLessThan(articleRect!.height - 20);

        await expandBtn.click();
        const restoredRect = await getOverlayBoxRect(fixturePage);
        expect(restoredRect).not.toBeNull();
        expect(Math.abs(restoredRect!.left - articleRect!.x)).toBeLessThanOrEqual(4);
        expect(Math.abs(restoredRect!.top - articleRect!.y)).toBeLessThanOrEqual(4);
        expect(Math.abs(restoredRect!.height - articleRect!.height)).toBeLessThanOrEqual(4);

        // Clicking a link on the page is captured (no navigation)
        const navBox = await fixturePage.locator("#nav-link").boundingBox();
        expect(navBox).not.toBeNull();
        await fixturePage.mouse.click(navBox!.x + navBox!.width / 2, navBox!.y + navBox!.height / 2);
        expect(fixturePage.url()).toBe(fixtureUrl);

        // Clicking a specific <section> selects just it
        await fixturePage.locator("#pick-section").scrollIntoViewIfNeeded();
        const sectionRect = await fixturePage.locator("#pick-section").boundingBox();
        expect(sectionRect).not.toBeNull();
        await fixturePage.mouse.click(
          sectionRect!.x + sectionRect!.width / 2,
          sectionRect!.y + sectionRect!.height / 2
        );
        const pickedRect = await getOverlayBoxRect(fixturePage);
        expect(pickedRect).not.toBeNull();
        expect(Math.abs(pickedRect!.top - sectionRect!.y)).toBeLessThanOrEqual(4);
        expect(Math.abs(pickedRect!.height - sectionRect!.height)).toBeLessThanOrEqual(4);

        // Esc resets back to the detected <article>
        await fixturePage.keyboard.press("Escape");
        await fixturePage.locator("#main-article").scrollIntoViewIfNeeded();
        const afterEscRect = await getOverlayBoxRect(fixturePage);
        expect(afterEscRect).not.toBeNull();
        expect(Math.abs(afterEscRect!.height - articleRect!.height)).toBeLessThanOrEqual(4);

        // 3a. Drag bottom handle DOWN to include #outside-para (outside <article>) -> save -> note contains it
        await fixturePage.locator("#outside-para").scrollIntoViewIfNeeded();
        const outsideRect = await fixturePage.locator("#outside-para").boundingBox();
        expect(outsideRect).not.toBeNull();
        const southHandle = fixturePage.locator('#joplin-clipper-overlay-host >> [data-handle="s"]');
        const southBox = await southHandle.boundingBox();
        expect(southBox).not.toBeNull();

        await fixturePage.mouse.move(southBox!.x + southBox!.width / 2, southBox!.y + southBox!.height / 2);
        await fixturePage.mouse.down();
        await fixturePage.mouse.move(
          southBox!.x + southBox!.width / 2,
          outsideRect!.y + outsideRect!.height + 24,
          { steps: 8 }
        );
        await fixturePage.mouse.up();

        const expandedRect = await getOverlayBoxRect(fixturePage);
        expect(expandedRect).not.toBeNull();
        expect(expandedRect!.bottom).toBeGreaterThanOrEqual(outsideRect!.y + outsideRect!.height - 4);

        await panel.bringToFront();
        await panel.locator("#clip-title").fill(`Expanded ${runTag}`);
        await panel.locator("#save-btn").click();
        const expandedNoteId = await extractNoteIdFromOpenLink(panel);
        createdNoteIds.push(expandedNoteId);
        await assertOverlayAndTempAttrsCleaned(fixturePage);

        const expandedNote = await fetchNote(appPage, expandedNoteId);
        expect(expandedNote.body).toContain("Outside appendix paragraph sitting below the article element");
        expect(expandedNote.body).toContain("detailed lead paragraph");
        expect(expandedNote.body).not.toContain("Secret Hidden Text");
        expect(expandedNote.body).not.toContain("Submit");
        createdResourceIds.push(
          ...[...expandedNote.body.matchAll(/!\[[^\]]*\]\(:\/([0-9a-f]{32})\)/g)].map((m) => m[1])
        );

        // 3b. Click "Clip again", drag bottom handle UP to exclude the last article paragraph -> save -> note excludes it
        await panel.locator("#clip-again-btn").click();
        await expect(panel.locator("#form-view")).toBeVisible();
        await fixturePage.bringToFront();
        await expect.poll(() => getOverlayBoxRect(fixturePage)).not.toBeNull();

        const middleParaRect = await fixturePage.locator("#middle-para").boundingBox();
        const lastParaRect = await fixturePage.locator("#last-article-para").boundingBox();
        expect(middleParaRect).not.toBeNull();
        expect(lastParaRect).not.toBeNull();

        const southBox2 = await southHandle.boundingBox();
        expect(southBox2).not.toBeNull();
        await fixturePage.mouse.move(southBox2!.x + southBox2!.width / 2, southBox2!.y + southBox2!.height / 2);
        await fixturePage.mouse.down();
        await fixturePage.mouse.move(
          southBox2!.x + southBox2!.width / 2,
          middleParaRect!.y + middleParaRect!.height + 2,
          { steps: 8 }
        );
        await fixturePage.mouse.up();

        const trimmedRect = await getOverlayBoxRect(fixturePage);
        expect(trimmedRect).not.toBeNull();
        expect(trimmedRect!.bottom).toBeLessThan(lastParaRect!.y + 8);

        await panel.bringToFront();
        await panel.locator("#clip-title").fill(`Trimmed ${runTag}`);
        await panel.locator("#save-btn").click();
        const trimmedNoteId = await extractNoteIdFromOpenLink(panel);
        createdNoteIds.push(trimmedNoteId);
        await assertOverlayAndTempAttrsCleaned(fixturePage);

        const trimmedNote = await fetchNote(appPage, trimmedNoteId);
        expect(trimmedNote.body).toContain("detailed lead paragraph");
        expect(trimmedNote.body).toContain("A second substantial paragraph");
        expect(trimmedNote.body).not.toContain("Final concluding article paragraph");
        createdResourceIds.push(
          ...[...trimmedNote.body.matchAll(/!\[[^\]]*\]\(:\/([0-9a-f]{32})\)/g)].map((m) => m[1])
        );

        // 4. Re-open overlay via "Clip again", then close panel -> port onDisconnect removes overlay
        await panel.locator("#clip-again-btn").click();
        await fixturePage.bringToFront();
        await expect.poll(() => getOverlayBoxRect(fixturePage)).not.toBeNull();
        await panel.close();
        await assertOverlayAndTempAttrsCleaned(fixturePage);
      } finally {
        await cleanupDemoResources(appPage, createdNoteIds, createdResourceIds, []);
      }
    } finally {
      await cleanup();
    }
  });

  test("screenshot mode crops to the dragged rectangle accounting for DPR", async ({ baseURL }) => {
    const serverUrl = baseURL!;
    const { context, extensionId, serviceWorker, cleanup } = await launchExtensionContext({
      deviceScaleFactor: 2,
    });
    try {
      const appPage = await configureSignedInExtension(context, extensionId, serverUrl);
      const fixtureUrl = `${fixture.url}/article`;
      const fixturePage = await context.newPage();
      await fixturePage.goto(fixtureUrl, { waitUntil: "load" });
      const fixtureTabId = await findTabIdByUrl(serviceWorker, fixtureUrl);

      const runTag = uniqueWord("crop");
      const createdNoteIds: string[] = [];
      const createdResourceIds: string[] = [];

      try {
        const panel = await openPanelForTab(context, extensionId, fixtureTabId);
        await panel.locator('button[data-mode="screenshot"]').click();
        await expect(panel.locator("#selection-summary")).toContainText(/Full visible area/);

        await fixturePage.bringToFront();
        await expect.poll(() => getOverlayBoxRect(fixturePage)).not.toBeNull();

        // Draw a 420 x 260 crop rectangle directly on the page
        const targetX = 180;
        const targetY = 120;
        const targetW = 420;
        const targetH = 260;

        await fixturePage.mouse.move(targetX, targetY);
        await fixturePage.mouse.down();
        await fixturePage.mouse.move(targetX + targetW, targetY + targetH, { steps: 8 });
        await fixturePage.mouse.up();

        const cropBox = await getOverlayBoxRect(fixturePage);
        expect(cropBox).not.toBeNull();
        expect(Math.abs(cropBox!.width - targetW)).toBeLessThanOrEqual(4);
        expect(Math.abs(cropBox!.height - targetH)).toBeLessThanOrEqual(4);

        const dpr = await fixturePage.evaluate(() => {
          const g = globalThis as unknown as BrowserGlobalLike;
          return g.window.devicePixelRatio || 1;
        });
        expect(dpr).toBe(2);

        await panel.bringToFront();
        await expect(panel.locator("#selection-summary")).toContainText(/Custom area/);
        await panel.locator("#clip-title").fill(`Cropped Shot ${runTag}`);
        await panel.locator("#save-btn").click();

        const noteId = await extractNoteIdFromOpenLink(panel);
        createdNoteIds.push(noteId);
        await assertOverlayAndTempAttrsCleaned(fixturePage);
        await panel.close();

        const note = await fetchNote(appPage, noteId);
        const shotMatch = /!\[[^\]]*\]\(:\/([0-9a-f]{32})\)/.exec(note.body);
        expect(shotMatch).not.toBeNull();
        createdResourceIds.push(shotMatch![1]);

        const res = await fetchResourceWithDimensions(appPage, shotMatch![1]);
        expect(res.status).toBe(200);
        expect(res.contentType).toBe("image/png");
        expect(Math.abs(res.pngWidth - Math.round(cropBox!.width * dpr))).toBeLessThanOrEqual(4);
        expect(Math.abs(res.pngHeight - Math.round(cropBox!.height * dpr))).toBeLessThanOrEqual(4);
      } finally {
        await cleanupDemoResources(appPage, createdNoteIds, createdResourceIds, []);
      }
    } finally {
      await cleanup();
    }
  });

  test("strict CSP page (default-src 'none'; style-src 'self') still renders the overlay with styles", async ({
    baseURL,
  }) => {
    const serverUrl = baseURL!;
    const { context, extensionId, serviceWorker, cleanup } = await launchExtensionContext();
    try {
      await configureSignedInExtension(context, extensionId, serverUrl);
      const cspUrl = `${fixture.url}/strict-csp`;
      const cspPage = await context.newPage();
      await cspPage.addInitScript(() => {
        const g = globalThis as unknown as BrowserGlobalLike;
        g.window.addEventListener("securitypolicyviolation", (e) => {
          g.__cspViolations = g.__cspViolations || [];
          g.__cspViolations.push(`${e.violatedDirective}:${e.blockedURI}`);
        });
      });
      await cspPage.goto(cspUrl, { waitUntil: "load" });
      const cspTabId = await findTabIdByUrl(serviceWorker, cspUrl);

      const panel = await openPanelForTab(context, extensionId, cspTabId);
      await panel.locator('button[data-mode="article"]').click();

      await cspPage.bringToFront();
      await expect.poll(() => getOverlayBoxRect(cspPage)).not.toBeNull();

      const articleRect = await cspPage.locator("#main-article").boundingBox();
      const overlayRect = await getOverlayBoxRect(cspPage);
      expect(articleRect).not.toBeNull();
      expect(overlayRect).not.toBeNull();
      expect(Math.abs(overlayRect!.width - articleRect!.width)).toBeLessThanOrEqual(4);
      expect(Math.abs(overlayRect!.height - articleRect!.height)).toBeLessThanOrEqual(4);

      const dimming = await getDimmingState(cspPage);
      expect(dimming).not.toBeNull();
      expect(dimming!.visibleSlabCount).toBeGreaterThanOrEqual(2);
      expect(dimming!.bg).toContain("rgba(15, 23, 42, 0.48)");
      expect(dimming!.borderStyle).toBe("solid");

      const recorded = await cspPage.evaluate(() => {
        const g = globalThis as unknown as BrowserGlobalLike;
        return g.__cspViolations || [];
      });
      expect(recorded).toEqual([]);

      await panel.close();
      await assertOverlayAndTempAttrsCleaned(cspPage);
    } finally {
      await cleanup();
    }
  });

  test("extends default box to include headline and intro, and never grows to body for site-header h1", async ({
    baseURL,
  }) => {
    const serverUrl = baseURL!;
    const { context, extensionId, serviceWorker, cleanup } = await launchExtensionContext();
    try {
      const appPage = await configureSignedInExtension(context, extensionId, serverUrl);
      const runTag = uniqueWord("hdr");
      const createdNoteIds: string[] = [];

      try {
        // 1. Heading + byline above a separate content div: box and saved note must include h1 and byline
        {
          const url = `${fixture.url}/heading-above-content`;
          const page = await context.newPage();
          await page.goto(url, { waitUntil: "load" });
          const tabId = await findTabIdByUrl(serviceWorker, url);

          const panel = await openPanelForTab(context, extensionId, tabId);
          await panel.locator('button[data-mode="article"]').click();

          await page.bringToFront();
          await expect.poll(() => getOverlayBoxRect(page)).not.toBeNull();
          const h1Rect = await page.locator("#post-h1").boundingBox();
          const contentRect = await page.locator("#post-content").boundingBox();
          const overlayRect = await getOverlayBoxRect(page);
          expect(h1Rect).not.toBeNull();
          expect(contentRect).not.toBeNull();
          expect(overlayRect).not.toBeNull();
          expect(overlayRect!.top).toBeLessThanOrEqual(h1Rect!.y + 4);
          expect(overlayRect!.bottom).toBeGreaterThanOrEqual(
            contentRect!.y + contentRect!.height - 4
          );

          await panel.bringToFront();
          await panel.locator("#clip-title").fill(`Heading ${runTag}`);
          await panel.locator("#save-btn").click();
          const noteId = await extractNoteIdFromOpenLink(panel);
          createdNoteIds.push(noteId);
          await panel.close();
          await page.close();

          const note = await fetchNote(appPage, noteId);
          expect(note.body).toContain("Designing Resilient Web Clippers");
          expect(note.body).toContain("Nov. 28, 2024");
          expect(note.body).toContain("First long prose paragraph");
        }

        // 2. Intro paragraph before the part Readability keeps (separated by <aside> TOC): box and note must include it, without sidebar
        {
          const url = `${fixture.url}/intro-before-readability`;
          const page = await context.newPage();
          await page.goto(url, { waitUntil: "load" });
          const tabId = await findTabIdByUrl(serviceWorker, url);

          const panel = await openPanelForTab(context, extensionId, tabId);
          await panel.locator('button[data-mode="article"]').click();

          await page.bringToFront();
          await expect.poll(() => getOverlayBoxRect(page)).not.toBeNull();
          const h1Rect = await page.locator("#doc-h1").boundingBox();
          const introRect = await page.locator("#doc-intro").boundingBox();
          const bodyRect = await page.locator("#doc-body").boundingBox();
          const overlayRect = await getOverlayBoxRect(page);
          expect(h1Rect).not.toBeNull();
          expect(introRect).not.toBeNull();
          expect(bodyRect).not.toBeNull();
          expect(overlayRect).not.toBeNull();
          expect(overlayRect!.top).toBeLessThanOrEqual(h1Rect!.y + 4);
          expect(overlayRect!.bottom).toBeGreaterThanOrEqual(bodyRect!.y + bodyRect!.height - 4);

          await panel.bringToFront();
          await panel.locator("#clip-title").fill(`Intro ${runTag}`);
          await panel.locator("#save-btn").click();
          const noteId = await extractNoteIdFromOpenLink(panel);
          createdNoteIds.push(noteId);
          await panel.close();
          await page.close();

          const note = await fetchNote(appPage, noteId);
          expect(note.body).toContain("Picture Element Reference");
          expect(note.body).toContain("Essential introductory summary paragraph");
          expect(note.body).toContain("Detailed first body paragraph");
          expect(note.body).not.toContain("SIDEBAR_TOC_MARKER");
        }

        // 3. Page whose only h1 is in a site header next to a nav: box must NOT grow to body or include the site header
        {
          const url = `${fixture.url}/site-header-h1`;
          const page = await context.newPage();
          await page.goto(url, { waitUntil: "load" });
          const tabId = await findTabIdByUrl(serviceWorker, url);

          const panel = await openPanelForTab(context, extensionId, tabId);
          await panel.locator('button[data-mode="article"]').click();

          await page.bringToFront();
          await expect.poll(() => getOverlayBoxRect(page)).not.toBeNull();
          const siteHeaderRect = await page.locator("#site-header").boundingBox();
          const entryRect = await page.locator("#entry-body").boundingBox();
          const bodyRect = await page.locator("body").boundingBox();
          const overlayRect = await getOverlayBoxRect(page);
          expect(siteHeaderRect).not.toBeNull();
          expect(entryRect).not.toBeNull();
          expect(bodyRect).not.toBeNull();
          expect(overlayRect).not.toBeNull();
          expect(overlayRect!.top).toBeGreaterThanOrEqual(
            siteHeaderRect!.y + siteHeaderRect!.height - 2
          );
          expect(overlayRect!.top).toBeLessThanOrEqual(entryRect!.y + 4);
          expect(overlayRect!.bottom).toBeGreaterThanOrEqual(
            entryRect!.y + entryRect!.height - 4
          );
          expect(overlayRect!.height).toBeLessThan(bodyRect!.height - 20);
          const selectedIncludesBodyOrHeader = await page.evaluate(() => {
            const g = globalThis as unknown as {
              document: { body: unknown; getElementById(id: string): unknown };
              __joplinClipperOverlay?: { getSelectedElements(): Array<{ contains?(n: unknown): boolean }> };
            };
            const els = g.__joplinClipperOverlay?.getSelectedElements() || [];
            const header = g.document.getElementById("site-header");
            return els.some((el) => el === g.document.body || (header && el.contains?.(header)));
          });
          expect(selectedIncludesBodyOrHeader).toBe(false);

          await panel.close();
          await assertOverlayAndTempAttrsCleaned(page);
          await page.close();
        }
      } finally {
        await cleanupDemoResources(appPage, createdNoteIds, [], []);
      }
    } finally {
      await cleanup();
    }
  });
});
