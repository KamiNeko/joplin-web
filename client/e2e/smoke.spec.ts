import { readFile } from "node:fs/promises";
import { expect, Page, test } from "@playwright/test";
import { demoId, signIn, uniqueWord } from "./helpers";

/** Opens the Reading List notebook and waits until its notes are listed */
async function openReadingList(page: Page) {
  await page.getByRole("complementary").first().getByRole("button", { name: /^Reading List/ }).click();
  await expect(page).toHaveURL(new RegExp(`/notebooks/${demoId("nb-reading")}(/|$)`));
  await expect(page.getByText("Book Notes: Deep Work")).toBeVisible();
}

/** Creates a note in the current list; it opens in the editor */
async function createNote(page: Page) {
  await page.getByRole("button", { name: "Create new note" }).click();
  await page.getByRole("menuitem", { name: "Note", exact: true }).click();
  await expect(page.getByLabel("Note title")).toBeVisible();
}

test.describe("sign-in", () => {
  test("rejects a wrong password and signs in with the demo account", async ({ page }) => {
    await page.goto("/notes");
    // Without a session the app sends you to the login page
    await expect(page).toHaveURL(/\/login$/);

    await page.getByLabel("Email Address").fill("demo@joplin-web.test");
    await page.getByLabel("Password").fill("wrong");
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page.getByText("Invalid email or password", { exact: false })).toBeVisible();

    await signIn(page);
    await expect(page).toHaveURL(/\/notes$/);
    await expect(page.getByRole("heading", { name: "All Notes" })).toBeVisible();
  });

  test("returns to the requested note after signing in, and signs out", async ({ page }) => {
    const roadmap = `/notebooks/${demoId("nb-projects")}/notes/${demoId("note-roadmap")}`;
    await page.goto(roadmap);
    await expect(page).toHaveURL(/\/login$/);

    await signIn(page, page.url());
    await expect(page).toHaveURL(new RegExp(`${roadmap}$`));
    await expect(page.getByRole("heading", { level: 1, name: "Website Relaunch Roadmap" })).toBeVisible();

    await page.getByRole("button", { name: "User account menu" }).click();
    await page.getByRole("menuitem", { name: "Sign Out" }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto("/notes");
    await expect(page).toHaveURL(/\/login/);
  });
});

test("browses notebooks and tags of the demo data", async ({ page }) => {
  await signIn(page);
  const sidebar = page.getByRole("complementary").first();

  await sidebar.getByRole("button", { name: /^Recipes/ }).click();
  await expect(page).toHaveURL(new RegExp(`/notebooks/${demoId("nb-recipes")}$`));
  await expect(page.getByText("Weeknight Miso Ramen")).toBeVisible();
  await expect(page.getByText("Website Relaunch Roadmap")).toHaveCount(0);

  await sidebar.getByRole("button", { name: /^books\b/ }).click();
  await expect(page).toHaveURL(new RegExp(`/notes\\?tag=${demoId("tag-books")}$`));
  await expect(page.getByText("Book Notes: Deep Work")).toBeVisible();
  await expect(page.getByText("Books to Read in 2026")).toBeVisible();
  await expect(page.getByText("Weeknight Miso Ramen")).toHaveCount(0);
});

test("creates, edits, tags, finds, trashes and restores a note", async ({ page }) => {
  const word = uniqueWord("zebra");
  const tag = uniqueWord("tag");
  const title = `E2E note ${word}`;
  await signIn(page);
  const sidebar = page.getByRole("complementary").first();

  // Create in the Reading List notebook
  await openReadingList(page);
  await createNote(page);

  // The new note opens in the editor
  await page.getByLabel("Note title").fill(title);
  await page.locator(".cm-content").click();
  await page.keyboard.type(`Written by the smoke test: ${word}`);
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(page.locator(".prose-content").getByText(`Written by the smoke test: ${word}`)).toBeVisible();

  // Tag it
  await page.getByRole("button", { name: "Tag", exact: true }).click();
  await page.getByLabel("Add tag").fill(tag);
  await page.getByLabel("Add tag").press("Enter");
  await page.getByLabel("Add tag").press("Escape");
  await expect(page.getByRole("button", { name: `#${tag}` })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: new RegExp(`^${tag}\\s*, 1 note$`) })).toBeVisible();

  // Edits survive a reload, so they reached the (mock) Joplin Server
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(page.getByRole("button", { name: `#${tag}` })).toBeVisible();

  // Find it through search from another list
  await sidebar.getByRole("button", { name: "All Notes" }).click();
  await page.getByRole("searchbox", { name: "Search notes" }).fill(word);
  await expect(page.getByText("1 found")).toBeVisible();
  await page.getByRole("button", { name: new RegExp(title) }).click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).first().click();

  // Trash it
  await page.getByRole("button", { name: "More note actions" }).click();
  await page.getByRole("menuitem", { name: "Move to trash" }).click();
  await expect(page.getByText("Note moved to trash")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: title })).toHaveCount(0);

  // Restore it from the trash
  await sidebar.getByRole("button", { name: "Trash" }).click();
  await page.getByText(title).first().click();
  await expect(page.getByText("In Trash")).toBeVisible();
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("Note restored")).toBeVisible();

  await openReadingList(page);
  await expect(page.getByText(title).first()).toBeVisible();
});

test("attaches a file to a note", async ({ page }) => {
  const word = uniqueWord("attach");
  await signIn(page);
  await openReadingList(page);
  await createNote(page);
  await page.getByLabel("Note title").fill(`Attachment ${word}`);

  await page.locator('input[type="file"]').setInputFiles({
    name: `${word}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.from("hello from the smoke test"),
  });
  // The placeholder becomes a link to the new resource
  await expect(page.locator(".cm-content")).toContainText(new RegExp(`\\[${word}\\.txt\\]\\(:/[0-9a-f]{32}\\)`));
  await page.getByRole("button", { name: "Done" }).click();

  // The rendered note links the attachment; clicking it downloads the uploaded file
  const download = page.waitForEvent("download");
  await page.locator(".prose-content").getByRole("button", { name: `${word}.txt` }).click();
  expect((await download).suggestedFilename()).toBe(`${word}.txt`);
  expect(await readFile(await (await download).path(), "utf8")).toBe("hello from the smoke test");
});

test("navigates on a phone between menu, list and note @phone", async ({ page }) => {
  await signIn(page);

  await page.getByRole("button", { name: "Toggle navigation menu" }).click();
  const menu = page.getByRole("dialog", { name: "Navigation Menu" });
  await menu.getByRole("button", { name: /^Travel/ }).click();
  await expect(menu).toBeHidden();

  await page.getByText("Lisbon Long Weekend").click();
  await expect(page.getByRole("heading", { level: 1, name: "Lisbon Long Weekend" })).toBeVisible();
  // One pane at a time: the list is hidden while the note is open
  await expect(page.getByRole("textbox", { name: "Filter this list" })).toBeHidden();

  await page.getByRole("button", { name: "Close note view" }).click();
  await expect(page.getByRole("textbox", { name: "Filter this list" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/notebooks/${demoId("nb-travel")}$`));
});
