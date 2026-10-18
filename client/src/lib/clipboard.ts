/**
 * Copies text to the clipboard. Falls back to a hidden textarea and `execCommand("copy")` where
 * the Clipboard API is missing, e.g. a self-hosted instance served over plain HTTP.
 * Resolves to false when neither works.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // denied or unavailable: try the fallback
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  const active = document.activeElement as HTMLElement | null;
  document.body.appendChild(textarea);
  textarea.select();
  let ok: boolean;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  textarea.remove();
  active?.focus?.();
  return ok;
}
