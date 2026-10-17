---
name: screenshots
description: Regenerate the README screenshots in docs/images from the demo environment (mock Joplin Server with sample notes). Use after visible UI changes or when the user asks for new or updated screenshots.
---

# Screenshots

1. Start the demo with the browser-preview launch configs `demo-server` (API :3101 + mock Joplin Server :22300) and `demo-client` (Vite :5174). Without the preview tools, run `npm --prefix server run demo` and `npm --prefix client run dev` in the background.
2. Capture:
   ```bash
   SCREENSHOT_BASE_URL=http://localhost:5174 npm --prefix client run screenshots
   ```
   This uses the locally installed Chrome. Set `SCREENSHOT_CHANNEL=msedge` to use Edge instead.
3. Open every PNG in `docs/images/` and check it: right view, no loading skeletons, no error toasts, readable text, and only demo content.
4. For a new view, add a step to `client/scripts/screenshots.mjs` (ids via `demoId` match `server/demo/seed.ts`), add sample content to the seed if needed, and reference the image from `README.md` with a short caption.
5. Stop the demo servers you started.
