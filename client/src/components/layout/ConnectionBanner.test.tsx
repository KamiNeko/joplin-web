import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { recordResponse, recordSignInRedirect, resetConnection } from "@/lib/connection";
import { ConnectionBanner } from "./ConnectionBanner";

afterEach(() => {
  cleanup();
  resetConnection();
});

describe("ConnectionBanner", () => {
  it("offers a reload while a sign-in proxy wants its login page", () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    render(<ConnectionBanner />);
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();

    act(() => recordSignInRedirect());
    expect(screen.getByText(/Your sign-in to this site has expired/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);

    act(() => recordResponse(200, true, ""));
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  });
});
