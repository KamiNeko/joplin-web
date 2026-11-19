import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { DEMO_EMAIL, DEMO_PASSWORD } from "./helpers";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER_DIR = path.join(REPO_ROOT, "server");
const CLIENT_DIR = path.join(REPO_ROOT, "client");
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32ToBuffer(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function generateTotpCode(secret: string, nowMs = Date.now()): { code: string; step: number } {
  const step = Math.floor(nowMs / 1000 / 30);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", base32ToBuffer(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return {
    code: String(binary % 1_000_000).padStart(6, "0"),
    step,
  };
}

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

async function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const doc = (
      globalThis as unknown as {
        document: { documentElement: { scrollWidth: number; clientWidth: number } };
      }
    ).document;
    return doc.documentElement.scrollWidth > doc.documentElement.clientWidth;
  });
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

interface IsolatedTwoFactorServer {
  baseUrl: string;
  apiUrl: string;
  cacheDir: string;
  stop: () => Promise<void>;
}

async function startIsolatedDemo(options: { require2fa: boolean }): Promise<IsolatedTwoFactorServer> {
  const usedPorts = new Set<number>();
  const apiPort = await getFreePort(usedPorts);
  const mockPort = await getFreePort(usedPorts);
  const clientPort = await getFreePort(usedPorts);
  const cacheDir = await mkdtemp(path.join(tmpdir(), "joplin-web-2fa-e2e-"));

  const serverEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(apiPort),
    MOCK_JOPLIN_PORT: String(mockPort),
    CACHE_DIR: cacheDir,
    REQUIRE_2FA: options.require2fa ? "true" : "false",
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

  const clientEnv: NodeJS.ProcessEnv = {
    ...process.env,
    API_PROXY_TARGET: `http://localhost:${apiPort}`,
  };
  const clientProc = spawn(
    "npm",
    ["--prefix", CLIENT_DIR, "run", "dev", "--", "--port", String(clientPort), "--strictPort"],
    {
      env: clientEnv,
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

  return { baseUrl, apiUrl, cacheDir, stop };
}

test.describe("two-factor authentication", () => {
  test("enrolls TOTP during REQUIRE_2FA login, logs out, and logs in again with TOTP code", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const server = await startIsolatedDemo({ require2fa: true });
    try {
      await page.goto(`${server.baseUrl}/login`);
      await page.getByLabel("Email Address").fill(DEMO_EMAIL);
      await page.getByLabel("Password").fill(DEMO_PASSWORD);
      await page.getByRole("button", { name: "Sign In" }).click();

      await expect(page.getByText("Set up two-factor authentication")).toBeVisible();
      const qrImage = page.getByAltText("Authenticator app QR code");
      await expect(qrImage).toBeVisible();
      await expect(qrImage).toHaveAttribute("src", /^data:image\/svg\+xml;/);

      const secretEl = page.getByTestId("totp-manual-secret");
      await expect(secretEl).toBeVisible();
      const secret = (await secretEl.innerText()).trim();
      expect(secret.length).toBeGreaterThanOrEqual(16);

      const { code: enrollCode, step: enrollStep } = generateTotpCode(secret);
      await page.getByLabel("Enter the 6-digit code").fill(enrollCode);
      await page.getByRole("button", { name: "Verify and continue" }).click();

      await expect(page.getByText("Save your recovery codes")).toBeVisible();
      const codeItems = page.getByRole("list", { name: "Recovery codes" }).locator("li");
      await expect(codeItems).toHaveCount(10);
      await expect(page.getByRole("button", { name: "Download .txt" })).toBeVisible();

      await page.getByRole("button", { name: "I saved them" }).click();
      await expect(page).toHaveURL(/\/(notes|notebooks)(\/|$)/);
      await expect(page.getByRole("heading", { name: "All Notes" })).toBeVisible();

      // Log out via user menu
      await page.getByRole("button", { name: "User account menu" }).click();
      await page.getByRole("menuitem", { name: "Sign Out" }).click();
      await expect(page).toHaveURL(/\/login$/);

      // Advance into the next 30s TOTP step so replay protection accepts a fresh code
      while (Math.floor(Date.now() / 1000 / 30) <= enrollStep) {
        const msRemaining = 30_000 - (Date.now() % 30_000) + 150;
        await page.waitForTimeout(Math.min(msRemaining, 2000));
      }

      await page.getByLabel("Email Address").fill(DEMO_EMAIL);
      await page.getByLabel("Password").fill(DEMO_PASSWORD);
      await page.getByRole("button", { name: "Sign In" }).click();

      await expect(page.getByText("Two-step verification")).toBeVisible();
      await expect(page.getByLabel("Trust this device for 30 days")).toBeVisible();

      const { code: loginCode } = generateTotpCode(secret);
      await page.getByLabel("Enter the 6-digit code").fill(loginCode);
      await page.getByRole("button", { name: "Verify" }).click();

      await expect(page).toHaveURL(/\/(notes|notebooks)(\/|$)/);
      await expect(page.getByRole("heading", { name: "All Notes" })).toBeVisible();

      // Verify Security settings reflects TOTP enabled
      await page.getByRole("button", { name: "User account menu" }).click();
      await page.getByRole("menuitem", { name: "Security" }).click();
      const dialog = page.getByRole("dialog", { name: /Security settings/i });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText("Enabled")).toBeVisible();
      await expect(dialog.getByText("10 remaining")).toBeVisible();
    } finally {
      await server.stop();
    }
  });

  test("enrolls a passkey via WebAuthn virtual authenticator and logs in with it", async ({ page }) => {
    test.setTimeout(60_000);
    const server = await startIsolatedDemo({ require2fa: true });
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("WebAuthn.enable", { enableUI: false });
      await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });

      await page.goto(`${server.baseUrl}/login`);
      await page.getByLabel("Email Address").fill(DEMO_EMAIL);
      await page.getByLabel("Password").fill(DEMO_PASSWORD);
      await page.getByRole("button", { name: "Sign In" }).click();

      await expect(page.getByText("Set up two-factor authentication")).toBeVisible();
      await page.getByRole("tab", { name: "Passkey" }).click();
      await page.getByLabel("Passkey name (optional)").fill("Test Virtual Passkey");
      await page.getByRole("button", { name: "Add a passkey" }).click();

      await expect(page.getByText("Save your recovery codes")).toBeVisible();
      await expect(page.getByRole("list", { name: "Recovery codes" }).locator("li")).toHaveCount(10);
      await page.getByRole("button", { name: "I saved them" }).click();
      await expect(page).toHaveURL(/\/(notes|notebooks)(\/|$)/);

      // Sign out and verify second login uses the passkey
      await page.getByRole("button", { name: "User account menu" }).click();
      await page.getByRole("menuitem", { name: "Sign Out" }).click();
      await expect(page).toHaveURL(/\/login$/);

      await page.getByLabel("Email Address").fill(DEMO_EMAIL);
      await page.getByLabel("Password").fill(DEMO_PASSWORD);
      await page.getByRole("button", { name: "Sign In" }).click();

      await expect(page.getByText("Two-step verification")).toBeVisible();
      const usePasskeyBtn = page.getByRole("button", { name: "Use a passkey" });
      await expect(usePasskeyBtn).toBeVisible();
      await usePasskeyBtn.click();

      await expect(page).toHaveURL(/\/(notes|notebooks)(\/|$)/);
      await expect(page.getByRole("heading", { name: "All Notes" })).toBeVisible();

      // Verify Security settings shows the registered passkey with last-used date
      await page.getByRole("button", { name: "User account menu" }).click();
      await page.getByRole("menuitem", { name: "Security" }).click();
      const dialog = page.getByRole("dialog", { name: /Security settings/i });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText("Test Virtual Passkey")).toBeVisible();
      await expect(dialog.getByText("Last used Never")).toHaveCount(0);
    } finally {
      await server.stop();
    }
  });

  test("renders enrollment and security settings cleanly at phone width @phone", async ({ page }) => {
    test.setTimeout(60_000);
    const server = await startIsolatedDemo({ require2fa: true });
    try {
      await page.goto(`${server.baseUrl}/login`);
      await page.getByLabel("Email Address").fill(DEMO_EMAIL);
      await page.getByLabel("Password").fill(DEMO_PASSWORD);
      await page.getByRole("button", { name: "Sign In" }).click();

      await expect(page.getByAltText("Authenticator app QR code")).toBeVisible();
      const secret = (await page.getByTestId("totp-manual-secret").innerText()).trim();
      const hasOverflowEnroll = await hasHorizontalOverflow(page);
      expect(hasOverflowEnroll).toBe(false);

      await page.getByLabel("Enter the 6-digit code").fill(generateTotpCode(secret).code);
      await page.getByRole("button", { name: "Verify and continue" }).click();

      await expect(page.getByText("Save your recovery codes")).toBeVisible();
      expect(await hasHorizontalOverflow(page)).toBe(false);
      await page.getByRole("button", { name: "I saved them" }).click();
      await expect(page).toHaveURL(/\/(notes|notebooks)(\/|$)/);

      await page.getByRole("button", { name: "User account menu" }).click();
      await page.getByRole("menuitem", { name: "Security" }).click();
      const dialog = page.getByRole("dialog", { name: /Security settings/i });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText("Enabled")).toBeVisible();
      const hasOverflowDialog = await hasHorizontalOverflow(page);
      expect(hasOverflowDialog).toBe(false);
    } finally {
      await server.stop();
    }
  });
});
