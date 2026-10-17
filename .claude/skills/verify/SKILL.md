---
name: verify
description: Run Joplin Web's full definition-of-done checks (server typecheck + tests, client lint + build, optional browser check against the demo) and report the results. Use before committing, before opening a PR, or when the user asks whether everything still works.
---

# Verify

Run the same checks as CI, then report.

1. Server, from the repo root:
   ```bash
   npm --prefix server run typecheck
   npm --prefix server test
   ```
2. Client:
   ```bash
   npm --prefix client run lint
   npm --prefix client run build
   ```
   Lint warnings are acceptable. Errors are not.
3. If the changes touch `client/src` and a browser preview is available: start the `demo-server` and `demo-client` launch configs, sign in with `demo@joplin-web.test` / `demo`, open the affected view, check the console for errors, and check light/dark and phone width (~390px).
4. If `docker` is available and `docker/` or dependencies changed, run `docker build -f docker/Dockerfile .`. Otherwise say the image is only built in CI.

Report one line per check (pass/fail + the key error output on failure). Don't fix failures silently: say what failed, then fix it if it's within the current task.
