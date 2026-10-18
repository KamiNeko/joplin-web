/**
 * Formats epoch timestamp or date string into human-friendly relative time.
 */
export function formatRelativeTime(timestamp: number | string | undefined): string {
  if (!timestamp) return "";

  let ms: number;
  if (typeof timestamp === "string") {
    ms = new Date(timestamp).getTime();
  } else if (timestamp < 10000000000) {
    // timestamp in seconds
    ms = timestamp * 1000;
  } else {
    // timestamp in milliseconds
    ms = timestamp;
  }

  if (isNaN(ms)) return "";

  const now = Date.now();
  const diffSec = Math.floor((now - ms) / 1000);

  if (diffSec < 45) return "just now";
  if (diffSec < 90) return "1 min ago";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} mins ago`;
  if (diffSec < 7200) return "1 hour ago";
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} hours ago`;
  if (diffSec < 172800) return "yesterday";
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)} days ago`;

  const date = new Date(ms);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  });
}
