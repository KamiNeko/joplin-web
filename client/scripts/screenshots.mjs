/**
 * Captures the README screenshots from the demo environment into docs/images/.
 *
 * 1. Start the demo: `npm --prefix server run demo` (mock Joplin Server + API on :3001)
 *    and `npm --prefix client run dev` (Vite on :5173).
 * 2. Run: `npm --prefix client run screenshots`
 *
 * Uses a locally installed Chrome (or Edge) through Playwright, no browser download needed.
 *   SCREENSHOT_BASE_URL   app URL (default http://localhost:5173)
 *   SCREENSHOT_CHANNEL    "chrome" (default) or "msedge"
 */
import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE_URL = process.env.SCREENSHOT_BASE_URL || "http://localhost:5173";
const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docs/images");

// Same ids as server/demo/seed.ts
const demoId = (key) => createHash("md5").update(`joplin-web-demo:${key}`).digest("hex");
const noteUrl = (notebook, note) => `/notebooks/${demoId(`nb-${notebook}`)}/notes/${demoId(`note-${note}`)}`;

const browser = await chromium.launch({ channel: process.env.SCREENSHOT_CHANNEL || "chrome" });

async function session({ theme, width = 1280, height = 800, mobile = false }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    isMobile: mobile,
    hasTouch: mobile,
    colorScheme: theme,
    locale: "en-US",
  });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/login`);
  await page.evaluate((t) => localStorage.setItem("joplin-theme", t), theme);
  await page.getByPlaceholder("name@example.com").fill("demo@joplin-web.test");
  await page.getByPlaceholder("••••••••").fill("demo");
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL("**/notes**");
  return { context, page };
}

async function open(page, url, waitForText) {
  await page.goto(`${BASE_URL}${url}`);
  await page.getByText(waitForText).filter({ visible: true }).first().waitFor();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);
}

async function shot(page, name) {
  const file = path.join(OUT_DIR, name);
  await page.screenshot({ path: file });
  console.log(`saved ${path.relative(process.cwd(), file)}`);
}

await mkdir(OUT_DIR, { recursive: true });

{
  const { context, page } = await session({ theme: "dark" });
  await open(page, noteUrl("projects", "roadmap"), "Open tasks");
  await shot(page, "notes-dark.png");

  await open(page, noteUrl("projects", "api-notes"), "Pagination");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("tab", { name: "Split" }).click();
  await page.waitForTimeout(500);
  await shot(page, "editor-split.png");
  await context.close();
}

{
  const { context, page } = await session({ theme: "light" });
  await open(page, noteUrl("travel", "lisbon"), "Itinerary");
  await shot(page, "notes-light.png");
  await context.close();
}

{
  const { context, page } = await session({ theme: "light", width: 390, height: 844, mobile: true });
  await open(page, noteUrl("recipes", "ramen"), "Ingredients");
  await shot(page, "mobile-note.png");
  await open(page, `/notebooks/${demoId("nb-recipes")}`, "Weeknight Miso Ramen");
  await shot(page, "mobile-list.png");
  await context.close();
}

await browser.close();
