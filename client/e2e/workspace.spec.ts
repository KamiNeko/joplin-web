import { expect, Page, test } from "@playwright/test";
import { demoId, expandSidebar, signIn, uniqueWord } from "./helpers";

async function openNotebook(page: Page, title: string, idKey: string) {
  await page.getByRole("complementary").first().getByRole("button", { name: new RegExp(`^${title}\\b`) }).click();
  await expect(page).toHaveURL(new RegExp(`/notebooks/${demoId(idKey)}(/|$)`));
  await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
}

test.describe("workspace features", () => {
  test("pins note & notebook shortcuts and opens them from sidebar and Home", async ({ page }) => {
    await signIn(page);
    const sidebar = page.getByRole("complementary").first();

    // Star "Book Notes: Deep Work"
    await page.getByRole("button", { name: /^Book Notes: Deep Work/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Book Notes: Deep Work" })).toBeVisible();
    await page.getByRole("button", { name: "Add to shortcuts" }).click();
    await expect(page.getByRole("button", { name: "Remove from shortcuts" })).toBeVisible();

    // Pin "Work" notebook from sidebar actions menu
    await sidebar.getByRole("button", { name: "Actions for Work" }).click();
    await page.getByRole("menuitem", { name: "Pin to shortcuts" }).click();

    await expect(sidebar.getByRole("button", { name: /^Shortcuts/ })).toHaveAttribute("aria-expanded", "true");
    await expect(sidebar.getByRole("button", { name: "Book Notes: Deep Work", exact: true })).toBeVisible();

    // Verify both shortcuts render on Home dashboard
    await sidebar.getByRole("button", { name: "Home", exact: true }).click();
    await expect(page).toHaveURL(/\/home$/);
    await expect(page.getByRole("heading", { level: 1, name: "Workspace Home" })).toBeVisible();
    const shortcutsSection = page.locator("section", {
      has: page.getByRole("heading", { level: 2, name: "Shortcuts" }),
    });
    await expect(shortcutsSection.getByRole("link", { name: /Book Notes: Deep Work/ })).toBeVisible();
    await expect(shortcutsSection.getByRole("link", { name: /^Work\b/ })).toBeVisible();

    // Clean up shortcuts so state stays tidy for other tests
    await sidebar.getByRole("button", { name: "Remove shortcut for Book Notes: Deep Work" }).click();
    await sidebar.getByRole("button", { name: "Remove shortcut for notebook Work" }).click();
  });

  test("tracks Recently Read & Recently Created across /recent and /home", async ({ page }) => {
    const uniqueTitle = `Created ${uniqueWord("recent")}`;
    await signIn(page);
    const sidebar = page.getByRole("complementary").first();

    // Read "Website Relaunch Roadmap" and let 500ms telemetry flush
    await page.getByRole("button", { name: /^Website Relaunch Roadmap/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Website Relaunch Roadmap" })).toBeVisible();
    await page.waitForTimeout(700);

    // Quick create from Home dashboard
    await sidebar.getByRole("button", { name: "Home", exact: true }).click();
    await expect(page).toHaveURL(/\/home$/);
    await page.getByLabel("Quick capture title").fill(uniqueTitle);
    await page.getByLabel("Quick capture body").fill("Captured from dashboard");
    await page.getByRole("button", { name: "Save Note" }).click();
    await expect(page.getByText("Note created")).toBeVisible();

    // Check /recent Recently Read and Recently Created tabs
    await sidebar.getByRole("button", { name: "Recent", exact: true }).click();
    await expect(page).toHaveURL(/\/recent$/);
    await expect(page.getByRole("button", { name: /Website Relaunch Roadmap/ })).toBeVisible();

    await page.getByRole("tab", { name: "Recently Created" }).click();
    await expect(page).toHaveURL(/\/recent\?tab=created$/);
    await expect(page.getByRole("button", { name: new RegExp(uniqueTitle) })).toBeVisible();
  });

  test("switches Collection Views (List, Gallery, Table, Board) and pins a Saved Search", async ({ page }) => {
    await signIn(page);
    const sidebar = page.getByRole("complementary").first();

    // Collection view switcher
    await page.getByRole("button", { name: "Gallery view" }).click();
    await expect(page.getByRole("button", { name: "Gallery view" })).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "Table view" }).click();
    await expect(page.getByRole("table")).toBeVisible();

    await page.getByRole("button", { name: "Board view" }).click();
    await expect(page.getByRole("heading", { level: 4, name: "Completed" })).toBeVisible();

    // Switch back to List view cleanly
    await page.getByRole("button", { name: "List view" }).click();
    await expect(page.getByRole("button", { name: "List view" })).toHaveAttribute("aria-pressed", "true");

    // Save a search shortcut
    await page.getByRole("searchbox", { name: "Search notes" }).fill("Backup Storage");
    await expect(page.getByText("1 found")).toBeVisible();
    await page.getByRole("button", { name: "Save search" }).click();
    const dialog = page.getByRole("dialog", { name: "Save search shortcut" });
    await dialog.getByRole("textbox").fill("Invoices query");
    await dialog.getByRole("button", { name: "Save shortcut" }).click();

    await page.getByRole("button", { name: "Clear search" }).first().click();
    await sidebar.getByRole("button", { name: "Invoices query", exact: true }).click();
    await expect(page.getByRole("searchbox", { name: "Search notes" })).toHaveValue("Backup Storage");
    await expect(page.getByText("1 found")).toBeVisible();

    // Clean up search and saved shortcut
    await page.getByRole("button", { name: "Clear search" }).first().click();
    await sidebar.getByRole("button", { name: "Remove saved search Invoices query" }).click();
  });

  test("opens Command Palette with Ctrl+P and queries Ask My Notes AI with citations", async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole("heading", { level: 2, name: "All Notes" })).toBeVisible();

    // Command Palette (Ctrl+P)
    await page.keyboard.press("Control+p");
    const paletteSearch = page.getByRole("combobox", { name: "Command palette search" });
    await expect(paletteSearch).toBeVisible();
    await paletteSearch.fill("Lisbon");
    await page.getByRole("option", { name: /Lisbon Long Weekend/ }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: "Lisbon Long Weekend" })).toBeVisible();

    // Ask My Notes drawer (AI_FAKE=1 in demo)
    await page.getByRole("button", { name: "Ask my notes" }).click();
    await page.getByLabel("Question for Ask My Notes").fill("What is the Website Relaunch plan?");
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await expect(page.getByText(/Sources \(\d+\)/)).toBeVisible();
    // Clicking the first cited note navigates cleanly
    await page.getByRole("dialog").locator("button:has(p)").first().click();
    await expect(page.getByLabel("Question for Ask My Notes")).toBeHidden();
  });

  test("supports slash commands, wiki-links, Rich mode, callouts, toggles, outline, properties & backlinks", async ({
    page,
  }) => {
    const suffix = uniqueWord("ws");
    const targetTitle = `Target Hub ${suffix}`;
    const sourceTitle = `Source Note ${suffix}`;
    await signIn(page);
    await openNotebook(page, "Reading List", "nb-reading");

    // 1. Create target note with two headings
    await page.getByRole("button", { name: "Create new note" }).click();
    await page.getByRole("menuitem", { name: "Note", exact: true }).click();
    await page.getByLabel("Note title").fill(targetTitle);
    await page.locator(".cm-content").click();
    await page.keyboard.type("# Section One\n\nTarget intro\n\n## Section Two\n\nDetails here");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: targetTitle })).toBeVisible();

    // 2. Create source note using Rich mode toggle + Slash command + Wiki-link
    await page.getByRole("button", { name: "Create new note" }).click();
    await page.getByRole("menuitem", { name: "Note", exact: true }).click();
    await page.getByLabel("Note title").fill(sourceTitle);

    await page.getByRole("button", { name: "Rich", exact: true }).click();
    await expect(page.getByLabel("Rich note editor")).toBeVisible();
    await page.getByLabel("Rich note editor").click();
    await page.keyboard.type("Written in rich mode");

    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const cm = page.locator(".cm-content");
    await cm.click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/warning");
    await expect(page.getByRole("listbox", { name: "Slash commands" })).toBeVisible();
    await page.getByRole("option", { name: /Callout: Warning/ }).click();
    await page.keyboard.type("Watch closely");
    // Enter 1 continues `> `, Enter 2 exits blockquote markup, Enter 3 adds a separating blank line
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type(`[[${targetTitle.slice(0, 14)}`);
    await expect(page.getByRole("listbox", { name: "Wiki-link note suggestions" })).toBeVisible();
    await page.getByRole("option", { name: targetTitle }).click();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("<details>\n<summary>Extra notes</summary>\n\nSecret inner text\n\n</details>");

    await page.getByRole("button", { name: "Done", exact: true }).click();

    // Switch back to Split so future edits start with default layout
    // Verify callout + collapsible details + Properties in Viewer
    await expect(page.locator('[data-callout="warning"]')).toContainText("Watch closely");
    const details = page.locator("details", { hasText: "Extra notes" });
    await details.locator("summary").click();
    await expect(details).toContainText("Secret inner text");

    await page.getByRole("button", { name: /Properties/i }).click();
    await expect(page.getByText(/\d+\s+words\s+\(\d+\s+chars\)/i)).toBeVisible();

    // Click inserted wiki-link to navigate to Target note -> verify Outline & Backlinks
    await page.locator(".prose-content").getByRole("button", { name: targetTitle }).click();
    await expect(page.getByRole("heading", { level: 1, name: targetTitle })).toBeVisible();

    await page.getByRole("button", { name: "Document outline" }).click();
    await expect(page.getByRole("button", { name: "Section Two", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Section Two", exact: true }).click();

    const backlinks = page.getByRole("region", { name: "Backlinks" });
    await expect(backlinks).toBeVisible();
    await expect(backlinks).toContainText(sourceTitle);

    // Clean up local editor mode preference
    await page.evaluate(() => localStorage.removeItem("joplin-editor-mode"));
  });

  test("manages Scratchpad, Global Tasks Hub, Hygiene Triage, and Web Clipper / Email Import", async ({ page }) => {
    const mailWord = uniqueWord("mail");
    await signIn(page);
    const sidebar = page.getByRole("complementary").first();

    // Scratchpad save + promote
    await sidebar.getByRole("button", { name: "Home", exact: true }).click();
    await page.getByLabel("Scratchpad").fill(`Scratch ${mailWord}\nReminder line`);
    await page.getByRole("button", { name: "Save now" }).click();
    await expect(page.getByText("Synced")).toBeVisible();
    await page.getByRole("button", { name: "Promote to Note" }).click();
    await expect(page.getByRole("heading", { level: 1, name: `Scratch ${mailWord}` })).toBeVisible();

    // Tasks Hub
    await sidebar.getByRole("button", { name: "Tasks", exact: true }).click();
    await expect(page).toHaveURL(/\/tasks$/);
    await expect(page.getByRole("heading", { level: 1, name: "Tasks Hub" })).toBeVisible();
    await expect(page.getByText("Renew passport")).toBeVisible();

    // Hygiene Triage
    await sidebar.getByRole("button", { name: "Hygiene", exact: true }).click();
    await expect(page).toHaveURL(/\/hygiene$/);
    await expect(page.getByText("Duplicate clusters")).toBeVisible();
    await expect(page.getByText("Untagged notes", { exact: true })).toBeVisible();

    // Share target / Clip URL prefill + Email import
    await page.goto("/clip?url=https%3A%2F%2Fexample.org%2Fguide&title=Shared+Guide");
    await expect(page.getByLabel("Article URL")).toHaveValue("https://example.org/guide");
    await page.getByRole("button", { name: "Copy code" }).click();
    await expect(page.getByText("Bookmarklet copied")).toBeVisible();

    await page.getByRole("tab", { name: /Email \/ \.eml Import/ }).click();
    await page.getByLabel("Raw email content").fill(
      `Subject: Receipt ${mailWord}\nFrom: billing@example.com\n\nAmount paid $42`
    );
    await page.getByRole("button", { name: "Import Email as Note" }).click();
    await expect(page.getByText("Email imported")).toBeVisible();
    await page.getByRole("link", { name: /Open note/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: `Receipt ${mailWord}` })).toBeVisible();
  });

  test("reaches workspace views cleanly on a phone @phone", async ({ page }) => {
    await expandSidebar(page.context());
    await signIn(page);

    await page.getByRole("button", { name: "Toggle navigation menu" }).click();
    const menu = page.getByRole("dialog", { name: "Navigation Menu" });
    await menu.getByRole("button", { name: "Tasks", exact: true }).click();
    await expect(menu).toBeHidden();
    await expect(page).toHaveURL(/\/tasks$/);
    await expect(page.getByRole("heading", { level: 1, name: "Tasks Hub" })).toBeVisible();
  });
});
