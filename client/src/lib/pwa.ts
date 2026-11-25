/**
 * Registers the service worker (public/sw.js) that makes Joplin Web installable as an app and
 * shows an offline page when the server can't be reached. Production builds only: in development
 * it would get in the way of Vite's reloads.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const register = () => {
    navigator.serviceWorker.register("/sw.js").catch((err: unknown) => {
      console.warn("[Joplin Web] Service worker registration failed:", err);
    });
  };
  // After the page has loaded, so the worker's own download doesn't compete with the app's
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}
