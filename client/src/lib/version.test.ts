import { afterEach, describe, expect, it, vi } from "vitest";

// __APP_VERSION__ / __GIT_SHA__ come from Vite's define; under Vitest they are globals that
// vi.stubGlobal can override. Each test re-imports the module so its constants see the stub.
async function loadVersion(appVersion: string, gitSha: string | null) {
  vi.stubGlobal("__APP_VERSION__", appVersion);
  vi.stubGlobal("__GIT_SHA__", gitSha);
  vi.resetModules();
  return import("./version");
}

afterEach(() => {
  vi.resetModules();
});

describe("version", () => {
  it("reports a tagged build with its short commit hash", async () => {
    const version = await loadVersion("1.2.0", "0123456789abcdef0123456789abcdef01234567");
    expect(version.APP_VERSION).toBe("1.2.0");
    expect(version.GIT_SHA).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(version.GIT_SHA_SHORT).toBe("0123456");
    expect(version.formatVersion()).toBe("1.2.0 (0123456)");
  });

  it("shows only the version when the commit is unknown", async () => {
    const version = await loadVersion("dev", null);
    expect(version.GIT_SHA).toBeNull();
    expect(version.GIT_SHA_SHORT).toBeNull();
    expect(version.formatVersion()).toBe("dev");
  });

  it("keeps a short hash as it is", async () => {
    const version = await loadVersion("dev", "abc1234");
    expect(version.GIT_SHA_SHORT).toBe("abc1234");
    expect(version.formatVersion()).toBe("dev (abc1234)");
  });
});
