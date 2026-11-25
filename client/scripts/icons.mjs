/**
 * Renders the app icons (PNG) from their SVG sources: public/icon.svg (the favicon, with transparent
 * corners) and scripts/icon-maskable.svg (full-bleed, for maskable icons and the Apple touch icon,
 * which the OS crops into its own shape).
 *
 * Run after changing an icon: `npm --prefix client run icons`
 * Uses a locally installed Chrome through Playwright, like the screenshots script.
 *   ICONS_CHANNEL   "chrome" (default) or "msedge"
 */
import { chromium } from "playwright";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ICONS = [
  { source: "public/icon.svg", size: 192, out: "public/icons/icon-192.png" },
  { source: "public/icon.svg", size: 512, out: "public/icons/icon-512.png" },
  { source: "scripts/icon-maskable.svg", size: 512, out: "public/icons/icon-maskable-512.png" },
  { source: "scripts/icon-maskable.svg", size: 180, out: "public/apple-touch-icon.png" },
];

const browser = await chromium.launch({ channel: process.env.ICONS_CHANNEL || "chrome" });
try {
  for (const { source, size, out } of ICONS) {
    const svg = await readFile(path.join(CLIENT_DIR, source), "utf8");
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`
    );
    await mkdir(path.dirname(path.join(CLIENT_DIR, out)), { recursive: true });
    await page.screenshot({ path: path.join(CLIENT_DIR, out), omitBackground: true });
    await page.close();
    console.log(`saved ${out}`);
  }
} finally {
  await browser.close();
}
