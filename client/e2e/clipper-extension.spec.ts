import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test, type BrowserContext, type Worker } from "@playwright/test";
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

async function startFixtureServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const reqPath = (req.url || "/").split("?")[0];
    if (reqPath === "/hero.png" || reqPath === "/lazy.png" || reqPath === "/og.png") {
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
      res.end(TINY_PNG);
      return;
    }
    if (reqPath === "/article") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Fixture Article Title</title>
    <meta property="og:title" content="Fixture Article Title" />
    <meta property="og:site_name" content="Fixture Press" />
    <meta name="description" content="A concise bookmark summary for the fixture article." />
    <meta property="og:image" content="/og.png" />
  </head>
  <body>
    <header><nav><a href="/home">Navigation</a></nav></header>
    <main>
      <article>
        <h1>Fixture Article Title</h1>
        <p class="byline">By Ada Lovelace</p>
        <p id="lead-para">
          This is a detailed lead paragraph about self-hosted note taking and browser web clipping.
          It contains enough prose so Mozilla Readability clearly recognizes this article block as
          the primary readable content of the page.
        </p>
        <div id="selectable-block">
          <p>Selected highlight paragraph with an embedded hero illustration below.</p>
          <img src="/hero.png" alt="Hero Illustration" width="64" height="64" />
        </div>
        <p>
          A second substantial paragraph ensures that Readability keeps the entire article structure,
          including the lazy-loaded diagram that follows immediately after this sentence.
        </p>
        <p>
          <img src="${PLACEHOLDER_GIF_DATA_URI}" data-src="/lazy.png" alt="Lazy Diagram" width="64" height="64" />
        </p>
      </article>
      <div style="display: none">Secret Hidden Text</div>
      <form action="/submit"><input type="text" name="secret" value="ignored" /></form>
      <script>window.__fixtureLoaded = true;</script>
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

async function launchExtensionContext(): Promise<{
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

test.describe("Clip to Joplin Web browser extension", () => {
  let fixture: { url: string; close: () => Promise<void> };

  test.beforeAll(async () => {
    fixture = await startFixtureServer();
  });

  test.afterAll(async () => {
    await fixture.close();
  });

  test("signed-out popup prompts the user to sign in and options test reports signed out", async ({ baseURL }) => {
    const serverUrl = baseURL!;
    const { context, extensionId, cleanup } = await launchExtensionContext();
    try {
      expect(extensionId).toBe(EXPECTED_EXTENSION_ID);

      // Configure server URL in options page (opened automatically on first run) and test while signed out
      const optionsPage = await getOrOpenOptionsPage(context, extensionId);
      await optionsPage.locator("#server-url").fill(serverUrl);
      await optionsPage.locator("#test-btn").click();
      await expect(optionsPage.locator("#status-banner")).toContainText(/Not signed in/i);

      // Opening popup while signed out shows the sign-in prompt
      const popupPage = await context.newPage();
      await popupPage.goto(`chrome-extension://${extensionId}/popup.html?noAutoOpen=1`);
      await expect(popupPage.getByRole("button", { name: "Sign in to Joplin Web" })).toBeVisible();
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

      // 1. Sign in to Joplin Web in the browser context so the SameSite=Strict cookie is stored
      const appPage = await context.newPage();
      await signIn(appPage, `${serverUrl}/login`);

      // 2. Configure the extension server URL in the options page and verify connection + origin allowlist
      const optionsPage = await getOrOpenOptionsPage(context, extensionId);
      await optionsPage.locator("#server-url").fill(serverUrl);
      await optionsPage.locator("#save-btn").click();
      await expect(optionsPage.locator("#status-banner")).toContainText("Saved server URL");
      await optionsPage.locator("#test-btn").click();
      await expect(optionsPage.locator("#status-banner")).toContainText(/Signed in/i);

      // 3. Open the local fixture article page in a tab
      const fixtureUrl = `${fixture.url}/article`;
      const fixturePage = await context.newPage();
      await fixturePage.goto(fixtureUrl, { waitUntil: "load" });
      await expect(fixturePage.locator("h1")).toHaveText("Fixture Article Title");

      const fixtureTabId = await serviceWorker.evaluate(async (targetUrl) => {
        const api = (
          globalThis as unknown as {
            chrome: { tabs: { query: (q: Record<string, unknown>) => Promise<Array<{ id?: number; url?: string }>> } };
          }
        ).chrome;
        const tabs = await api.tabs.query({});
        const found = tabs.find((t) => t.url === targetUrl);
        return found?.id ?? null;
      }, fixtureUrl);
      expect(fixtureTabId).not.toBeNull();

      interface ClippedNoteResponse {
        id: string;
        title: string;
        body: string;
        parentId: string;
        markupLanguage: number;
        tags: Array<{ id: string; title: string }>;
      }

      // Helper to read a created note + verify attachment binaries via the signed-in app page
      const fetchNote = async (noteId: string): Promise<ClippedNoteResponse> =>
        appPage.evaluate(async (id) => {
          const res = await fetch(`/api/notes/${id}`, { credentials: "include" });
          if (!res.ok) throw new Error(`GET /api/notes/${id} failed: ${res.status}`);
          return (await res.json()) as ClippedNoteResponse;
        }, noteId);

      const fetchResource = async (resId: string) =>
        appPage.evaluate(async (id) => {
          const res = await fetch(`/api/resources/${id}`, { credentials: "include" });
          const buf = await res.arrayBuffer();
          return { status: res.status, contentType: res.headers.get("content-type"), size: buf.byteLength };
        }, resId);

      const openPopup = async () => {
        const p = await context.newPage();
        await p.goto(`chrome-extension://${extensionId}/popup.html?tabId=${fixtureTabId}&noAutoOpen=1`);
        await expect(p.locator("#form-view")).toBeVisible();
        return p;
      };

      const extractNoteIdFromOpenLink = async (popup: Awaited<ReturnType<typeof openPopup>>) => {
        await expect(popup.locator("#success-view")).toBeVisible({ timeout: 20_000 });
        const href = await popup.locator("#open-note-link").getAttribute("href");
        expect(href).toMatch(/\/notes\/[0-9a-f]{32}$/);
        return href!.split("/notes/")[1];
      };

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
          const popup = await openPopup();
          await expect(popup.locator('button[data-mode="selection"]')).toBeDisabled();
          await popup.locator('button[data-mode="article"]').click();
          const title = `Article ${runTag}`;
          await popup.locator("#clip-title").fill(title);
          await popup.locator("#clip-notebook").selectOption(demoId("nb-work"));
          // Use autocomplete for existing "planning" tag + add a custom tag
          await popup.locator("#clip-tag-input").fill("plan");
          await popup.locator("#tag-suggestions button", { hasText: "planning" }).click();
          await popup.locator("#clip-tag-input").fill(`${runTag}-art`);
          await popup.locator("#save-btn").click();

          const noteId = await extractNoteIdFromOpenLink(popup);
          createdNoteIds.push(noteId);
          await expect(popup.locator("#success-message")).toContainText("Work");
          await popup.close();

          const note = await fetchNote(noteId);
          expect(note.title).toBe(title);
          expect(note.parentId).toBe(demoId("nb-work"));
          expect(note.markupLanguage).toBe(1);
          expect(note.tags.map((t: { title: string }) => t.title)).toEqual(
            expect.arrayContaining(["planning", `${runTag}-art`])
          );
          const imgIds = [...(note.body as string).matchAll(/!\[[^\]]*\]\(:\/([0-9a-f]{32})\)/g)].map((m) => m[1]);
          expect(imgIds.length).toBe(2);
          createdResourceIds.push(...imgIds);
          expect(note.body).not.toContain("/hero.png");
          expect(note.body).not.toContain("/lazy.png");
          for (const id of imgIds) {
            const resource = await fetchResource(id);
            expect(resource.status).toBe(200);
            expect(resource.contentType).toBe("image/png");
            expect(resource.size).toBe(TINY_PNG.length);
          }
        }

        // --- Mode 2: Selection ---
        {
          await fixturePage.evaluate(() => {
            const g = globalThis as unknown as {
              document: {
                getElementById(id: string): unknown;
                createRange(): { selectNodeContents(n: unknown): void };
              };
              window: {
                getSelection(): { removeAllRanges(): void; addRange(r: unknown): void } | null;
              };
            };
            const target = g.document.getElementById("selectable-block");
            const range = g.document.createRange();
            range.selectNodeContents(target);
            const sel = g.window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(range);
          });

          const popup = await openPopup();
          await expect(popup.locator('button[data-mode="selection"]')).toBeEnabled();
          await popup.locator('button[data-mode="selection"]').click();
          const title = `Selection ${runTag}`;
          await popup.locator("#clip-title").fill(title);
          await popup.locator("#clip-tag-input").fill(`${runTag}-sel`);
          await popup.locator("#save-btn").click();

          const noteId = await extractNoteIdFromOpenLink(popup);
          createdNoteIds.push(noteId);
          await popup.close();

          const note = await fetchNote(noteId);
          expect(note.title).toBe(title);
          expect(note.markupLanguage).toBe(1);
          expect(note.body).toContain("Selected highlight paragraph");
          expect(note.tags.map((t: { title: string }) => t.title)).toContain(`${runTag}-sel`);
          const selMatch = /!\[Hero Illustration\]\(:\/([0-9a-f]{32})\)/.exec(note.body);
          expect(selMatch).not.toBeNull();
          createdResourceIds.push(selMatch![1]);
        }

        // --- Mode 3: Full page (HTML note) ---
        {
          const popup = await openPopup();
          await popup.locator('button[data-mode="fullpage"]').click();
          const title = `FullPage ${runTag}`;
          await popup.locator("#clip-title").fill(title);
          await popup.locator("#clip-tag-input").fill(`${runTag}-full`);
          await popup.locator("#save-btn").click();

          const noteId = await extractNoteIdFromOpenLink(popup);
          createdNoteIds.push(noteId);
          await popup.close();

          const note = await fetchNote(noteId);
          expect(note.title).toBe(title);
          expect(note.markupLanguage).toBe(2);
          expect(note.tags.map((t: { title: string }) => t.title)).toContain(`${runTag}-full`);
          const fullIds = [...note.body.matchAll(/src=":\/([0-9a-f]{32})"/g)].map((m) => m[1]);
          expect(fullIds.length).toBeGreaterThanOrEqual(2);
          createdResourceIds.push(...fullIds);
          expect(note.body).not.toMatch(/<script|<form/i);
          expect(note.body).not.toContain("Secret Hidden Text");
        }

        // --- Mode 4: Screenshot ---
        {
          const popup = await openPopup();
          await popup.locator('button[data-mode="screenshot"]').click();
          const title = `Screenshot ${runTag}`;
          await popup.locator("#clip-title").fill(title);
          await popup.locator("#clip-tag-input").fill(`${runTag}-shot`);
          await popup.locator("#save-btn").click();

          const noteId = await extractNoteIdFromOpenLink(popup);
          createdNoteIds.push(noteId);
          await popup.close();

          const note = await fetchNote(noteId);
          expect(note.title).toBe(title);
          expect(note.markupLanguage).toBe(1);
          expect(note.body).toContain(fixtureUrl);
          expect(note.tags.map((t: { title: string }) => t.title)).toContain(`${runTag}-shot`);
          const shotMatch = /!\[[^\]]*\]\(:\/([0-9a-f]{32})\)/.exec(note.body);
          expect(shotMatch).not.toBeNull();
          createdResourceIds.push(shotMatch![1]);
          const shotRes = await fetchResource(shotMatch![1]);
          expect(shotRes.status).toBe(200);
          expect(shotRes.contentType).toBe("image/png");
          expect(shotRes.size).toBeGreaterThan(100);
        }

        // --- Mode 5: Bookmark ---
        {
          const popup = await openPopup();
          await popup.locator('button[data-mode="bookmark"]').click();
          const title = `Bookmark ${runTag}`;
          await popup.locator("#clip-title").fill(title);
          await popup.locator("#clip-tag-input").fill(`${runTag}-bm`);
          await popup.locator("#save-btn").click();

          const noteId = await extractNoteIdFromOpenLink(popup);
          createdNoteIds.push(noteId);
          await popup.close();

          const note = await fetchNote(noteId);
          expect(note.title).toBe(title);
          expect(note.markupLanguage).toBe(1);
          expect(note.body).toContain("A concise bookmark summary for the fixture article.");
          expect(note.body).toContain(fixtureUrl);
          expect(note.tags.map((t: { title: string }) => t.title)).toContain(`${runTag}-bm`);
          const ogMatch = /!\[[^\]]*\]\(:\/([0-9a-f]{32})\)/.exec(note.body);
          expect(ogMatch).not.toBeNull();
          createdResourceIds.push(ogMatch![1]);
          const ogRes = await fetchResource(ogMatch![1]);
          expect(ogRes.status).toBe(200);
          expect(ogRes.contentType).toBe("image/png");
        }
      } finally {
        // Restore shared demo server counts so subsequent specs see the original seeded state
        await appPage.evaluate(
          async ({ noteIds, resourceIds, tagNames }) => {
            for (const id of noteIds) {
              await fetch(`/api/notes/${id}`, { method: "DELETE", credentials: "include" }).catch(() => {});
              await fetch(`/api/notes/${id}?permanent=true`, { method: "DELETE", credentials: "include" }).catch(() => {});
            }
            for (const id of resourceIds) {
              await fetch(`/api/resources/${id}`, { method: "DELETE", credentials: "include" }).catch(() => {});
            }
            const tagsRes = await fetch("/api/tags", { credentials: "include" }).catch(() => null);
            if (tagsRes && tagsRes.ok) {
              const allTags = (await tagsRes.json()) as Array<{ id: string; title: string }>;
              const wanted = new Set(tagNames);
              for (const tag of allTags) {
                if (wanted.has(tag.title)) {
                  await fetch(`/api/tags/${tag.id}`, { method: "DELETE", credentials: "include" }).catch(() => {});
                }
              }
            }
          },
          {
            noteIds: createdNoteIds,
            resourceIds: Array.from(new Set(createdResourceIds)),
            tagNames: Array.from(createdTagNames),
          }
        );
      }
    } finally {
      await cleanup();
    }
  });
});
