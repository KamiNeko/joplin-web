import { expect, test } from "@playwright/test";
import { demoId, expandSidebar, signIn, uniqueWord } from "./helpers";

test("syncs sidebar tags, notebook counts and notes across tabs without reload", async ({ context, page }) => {
  const word = uniqueWord("crosstab");
  const tag = uniqueWord("cttag");
  const initialTitle = `Cross-tab ${word}`;
  const updatedTitle = `Cross-tab updated ${word}`;

  await expandSidebar(context);
  await signIn(page);
  await expect(page.getByRole("heading", { name: "All Notes" })).toBeVisible();
  const sidebar1 = page.getByRole("complementary").first();

  // Second tab open on /notes in the same browser context (same session, never reloaded or focused)
  const otherTab = await context.newPage();
  await otherTab.goto("/notes");
  await expect(otherTab.getByRole("heading", { name: "All Notes" })).toBeVisible();
  const sidebar2 = otherTab.getByRole("complementary").first();

  await expect(sidebar2.getByRole("button", { name: /^Reading List\s*, 3 notes$/ })).toBeVisible();
  await expect(sidebar2.getByRole("button", { name: /^Travel\s*, 2 notes$/ })).toBeVisible();
  await expect(sidebar2.getByRole("button", { name: /^cooking\s*, 2 notes$/ })).toBeVisible();

  // Bring focus back to the first tab cleanly before writing there
  await page.bringToFront();

  // 1. Create a note in Reading List
  await sidebar1.getByRole("button", { name: /^Reading List\b/ }).click();
  await expect(page).toHaveURL(new RegExp(`/notebooks/${demoId("nb-reading")}(/|$)`));
  await expect(page.getByRole("heading", { name: "Reading List" })).toBeVisible();
  await page.getByRole("button", { name: "Create new note" }).click();
  await page.getByRole("menuitem", { name: "Note", exact: true }).click();
  await page.getByLabel("Note title").fill(initialTitle);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: initialTitle })).toBeVisible();

  // (a) Same tab and (b) other tab update notebook count and note list without reload
  await expect(sidebar1.getByRole("button", { name: /^Reading List\s*, 4 notes$/ })).toBeVisible();
  await expect(sidebar2.getByRole("button", { name: /^Reading List\s*, 4 notes$/ })).toBeVisible();
  await expect(otherTab.getByText(initialTitle)).toBeVisible();

  // 2. Add a new tag and an existing tag via Tag -> "Add tag…"
  await page.getByRole("button", { name: "Tag", exact: true }).click();
  const addTagInput = page.getByLabel("Add tag");
  await addTagInput.fill(tag);
  await addTagInput.press("Enter");
  await expect(page.getByRole("button", { name: `#${tag}` })).toBeVisible();
  await addTagInput.fill("cooking");
  await addTagInput.press("Enter");
  await addTagInput.press("Escape");
  await expect(page.getByRole("button", { name: "#cooking" })).toBeVisible();

  await expect(sidebar1.getByRole("button", { name: new RegExp(`^${tag}\\s*, 1 note$`) })).toBeVisible();
  await expect(sidebar1.getByRole("button", { name: /^cooking\s*, 3 notes$/ })).toBeVisible();
  await expect(sidebar2.getByRole("button", { name: new RegExp(`^${tag}\\s*, 1 note$`) })).toBeVisible();
  await expect(sidebar2.getByRole("button", { name: /^cooking\s*, 3 notes$/ })).toBeVisible();

  // 3. Move the note to Travel (notebook counts change in both notebooks)
  await page.getByRole("button", { name: "More note actions" }).click();
  await page.getByRole("menuitem", { name: "Move to notebook" }).hover();
  await page.getByRole("menuitem", { name: "Travel" }).click();
  await expect(sidebar1.getByRole("button", { name: /^Reading List\s*, 3 notes$/ })).toBeVisible();
  await expect(sidebar1.getByRole("button", { name: /^Travel\s*, 3 notes$/ })).toBeVisible();
  await expect(sidebar2.getByRole("button", { name: /^Reading List\s*, 3 notes$/ })).toBeVisible();
  await expect(sidebar2.getByRole("button", { name: /^Travel\s*, 3 notes$/ })).toBeVisible();

  // 4. Edit title via editor ("Done" saves through use-note-saver)
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Note title").fill(updatedTitle);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: updatedTitle })).toBeVisible();
  await expect(otherTab.getByText(updatedTitle)).toBeVisible();

  // 5. Clean up the test note and custom tag so the shared demo state stays clean
  await page.getByRole("button", { name: "More note actions" }).click();
  await page.getByRole("menuitem", { name: "Move to trash" }).click();
  await expect(page.getByText("Note moved to trash")).toBeVisible();
  await sidebar1.getByRole("button", { name: "Trash" }).click();
  await expect(page.getByRole("heading", { name: "Trash" })).toBeVisible();
  await page.getByRole("heading", { level: 3, name: updatedTitle }).click();
  await page.getByRole("button", { name: "Delete permanently" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete permanently" }).click();
  await expect(page.getByRole("heading", { level: 3, name: updatedTitle })).toHaveCount(0);
  await sidebar1.getByRole("button", { name: `Actions for tag ${tag}` }).click();
  await page.getByRole("menuitem", { name: "Delete tag" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete tag" }).click();

  await expect(sidebar2.getByRole("button", { name: /^Travel\s*, 2 notes$/ })).toBeVisible();
  await expect(sidebar2.getByRole("button", { name: /^cooking\s*, 2 notes$/ })).toBeVisible();
  await expect(sidebar2.getByRole("button", { name: new RegExp(`^${tag}\\b`) })).toHaveCount(0);
});
