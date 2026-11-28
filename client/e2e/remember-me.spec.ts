import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { DEMO_EMAIL, DEMO_PASSWORD } from "./helpers";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER_DIR = path.join(REPO_ROOT, "server");
const CLIENT_DIR = path.join(REPO_ROOT, "client");

async function getFreePort(avoid = new Set<number>()): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const allocated = typeof addr === "object" && addr ? addr.port : 0;
        server.close((err) => (err ? reject(err) : resolve(allocated)));
      });
    });
    if (!avoid.has(port)) {
      avoid.add(port);
      return port;
    }
  }
  throw new Error("Could not allocate unique free port");
}

function attachLogTail(proc: ChildProcess): () => string {
  let output = "";
  const append = (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-4000);
  };
  proc.stdout?.on("data", append);
  proc.stderr?.on("data", append);
  return () => output;
}

async function killProcessGroup(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null || !proc.pid) return;
  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    return;
  }
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (proc.exitCode === null && proc.signalCode === null) {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // ignore if already gone
    }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
}

async function waitForHttpReady(url: string, proc: ChildProcess, getLogs: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`Process exited early (${proc.exitCode}) waiting for ${url}:\n${getLogs()}`);
    }
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // keep polling until deadline
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}:\n${getLogs()}`);
}

async function startIsolatedDemo(): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  const usedPorts = new Set<number>();
  const apiPort = await getFreePort(usedPorts);
  const mockPort = await getFreePort(usedPorts);
  const clientPort = await getFreePort(usedPorts);
  const cacheDir = await mkdtemp(path.join(tmpdir(), "joplin-web-remember-e2e-"));

  const serverEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(apiPort),
    MOCK_JOPLIN_PORT: String(mockPort),
    CACHE_DIR: cacheDir,
    REQUIRE_2FA: "false",
    CORS_ORIGIN: `http://localhost:${clientPort}`,
    NODE_ENV: "development",
  };
  delete serverEnv.PUBLIC_URL;

  const serverProc = spawn("npm", ["--prefix", SERVER_DIR, "run", "demo"], {
    env: serverEnv,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const getServerLogs = attachLogTail(serverProc);

  const clientProc = spawn(
    "npm",
    ["--prefix", CLIENT_DIR, "run", "dev", "--", "--port", String(clientPort), "--strictPort"],
    {
      env: { ...process.env, API_PROXY_TARGET: `http://localhost:${apiPort}` },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    }
  );
  const getClientLogs = attachLogTail(clientProc);

  const apiUrl = `http://localhost:${apiPort}`;
  const baseUrl = `http://localhost:${clientPort}`;

  const stop = async () => {
    await Promise.allSettled([killProcessGroup(clientProc), killProcessGroup(serverProc)]);
    await rm(cacheDir, { recursive: true, force: true });
  };

  try {
    await waitForHttpReady(`${apiUrl}/api/health`, serverProc, getServerLogs);
    await waitForHttpReady(`${baseUrl}/login`, clientProc, getClientLogs);
  } catch (err) {
    await stop();
    throw err;
  }

  return { baseUrl, stop };
}

test.describe("remember me for 30 days", () => {
  test("restores the session after the session cookie is deleted and supports revoking in Security settings", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const server = await startIsolatedDemo();
    try {
      await page.goto(`${server.baseUrl}/login`);
      const rememberCheckbox = page.getByLabel("Remember me for 30 days");
      await expect(rememberCheckbox).toBeVisible();
      await expect(rememberCheckbox).not.toBeChecked();
      await rememberCheckbox.check();

      await page.getByLabel("Email Address").fill(DEMO_EMAIL);
      await page.getByLabel("Password").fill(DEMO_PASSWORD);
      await page.getByRole("button", { name: "Sign In" }).click();

      await expect(page).toHaveURL(/\/notes$/);
      await expect(page.getByRole("heading", { name: "All Notes" })).toBeVisible();

      const beforeCookies = await page.context().cookies();
      const sessionBefore = beforeCookies.find((c) => c.name === "joplin_web_session");
      const rememberBefore = beforeCookies.find((c) => c.name === "joplin_web_remember");
      expect(sessionBefore).toBeTruthy();
      expect(rememberBefore).toBeTruthy();

      // Simulate browser reopen / session expiry by deleting only the session cookie
      await page.context().clearCookies({ name: "joplin_web_session" });
      await page.reload();

      // Should stay signed in via remember-me restore with no session-expired dialog
      await expect(page).toHaveURL(/\/notes$/);
      await expect(page.getByRole("heading", { name: "All Notes" })).toBeVisible();
      await expect(page.getByRole("dialog", { name: "Session expired" })).toHaveCount(0);

      const afterCookies = await page.context().cookies();
      const sessionAfter = afterCookies.find((c) => c.name === "joplin_web_session");
      expect(sessionAfter).toBeTruthy();
      expect(sessionAfter!.value).not.toBe(sessionBefore!.value);

      // Verify Security settings lists the remembered sign-in and allows revoking it
      await page.getByRole("button", { name: "User account menu" }).click();
      await page.getByRole("menuitem", { name: "Security" }).click();
      const dialog = page.getByRole("dialog", { name: /Security settings/i });
      await expect(dialog).toBeVisible();

      const section = dialog.getByRole("region", { name: "Remembered sign-ins" });
      await expect(section).toBeVisible();
      await expect(section.getByText("This device")).toBeVisible();

      await section.getByRole("button", { name: /^Revoke remembered sign-in/i }).click();
      await expect(section.getByText("No remembered sign-ins.")).toBeVisible();
    } finally {
      await server.stop();
    }
  });
});
