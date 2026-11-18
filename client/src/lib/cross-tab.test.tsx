import { act, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { invalidateAllExceptUnsaved } from "@/hooks/use-connection";
import { invalidateLists } from "@/hooks/use-mutations";
import { createNoteSaver } from "@/hooks/use-note-saver";
import * as api from "@/lib/api";
import { setNoteUnsaved } from "@/lib/connection";
import {
  announceWrite,
  createCrossTabSync,
  CROSS_TAB_CHANNEL,
  onRemoteWrite,
  setCrossTabUser,
} from "@/lib/cross-tab";
import { jsonResponse, mockFetch } from "@/test/fetch-mock";
import { testQueryClient } from "@/test/render";

/** Minimal spec-faithful BroadcastChannel fake: delivers to every other open instance on the channel. */
class FakeBroadcastChannel {
  static channels = new Map<string, Set<FakeBroadcastChannel>>();
  static posted: Array<{ name: string; data: unknown }> = [];

  readonly name: string;
  private listeners = new Set<(event: MessageEvent<unknown>) => void>();
  private closed = false;

  constructor(name: string) {
    this.name = name;
    let peers = FakeBroadcastChannel.channels.get(name);
    if (!peers) {
      peers = new Set();
      FakeBroadcastChannel.channels.set(name, peers);
    }
    peers.add(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    if (type !== "message") return;
    if (typeof listener === "function") this.listeners.add(listener as (event: MessageEvent<unknown>) => void);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    if (type !== "message") return;
    if (typeof listener === "function") this.listeners.delete(listener as (event: MessageEvent<unknown>) => void);
  }

  postMessage(data: unknown) {
    if (this.closed) throw new DOMException("Channel is closed", "InvalidStateError");
    FakeBroadcastChannel.posted.push({ name: this.name, data });
    const peers = [...(FakeBroadcastChannel.channels.get(this.name) ?? [])];
    for (const peer of peers) {
      // BroadcastChannel never delivers to the posting channel itself
      if (peer === this || peer.closed) continue;
      const event = new MessageEvent("message", { data });
      [...peer.listeners].forEach((listener) => listener(event));
    }
  }

  close() {
    this.closed = true;
    FakeBroadcastChannel.channels.get(this.name)?.delete(this);
  }

  static reset() {
    this.channels.clear();
    this.posted = [];
  }
}

const CLEAN_NOTE_ID = "0".repeat(32);
const UNSAVED_NOTE_ID = "1".repeat(32);
const NB_ID = "2".repeat(32);
const USER_ALICE = "alice@example.com|notes.example.com";
const USER_BOB = "bob@example.com|notes.example.com";

function seedClientCache(client: QueryClient) {
  for (const key of [["notes"], ["notebooks"], ["tags"], ["search", "milk"]]) {
    client.setQueryData(key, []);
  }
  client.setQueryData(["note", CLEAN_NOTE_ID], { id: CLEAN_NOTE_ID, title: "Clean", body: "" });
  client.setQueryData(["note", UNSAVED_NOTE_ID], { id: UNSAVED_NOTE_ID, title: "Draft", body: "wip" });
}

const isStale = (client: QueryClient, key: unknown[]) => client.getQueryState(key)?.isInvalidated === true;

describe("cross-tab sync", () => {
  beforeEach(() => {
    FakeBroadcastChannel.reset();
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    setCrossTabUser(null);
    setNoteUnsaved(UNSAVED_NOTE_ID, false);
    setNoteUnsaved(CLEAN_NOTE_ID, false);
    localStorage.clear();
  });

  afterEach(() => {
    setCrossTabUser(null);
    setNoteUnsaved(UNSAVED_NOTE_ID, false);
    setNoteUnsaved(CLEAN_NOTE_ID, false);
    FakeBroadcastChannel.reset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("invalidates lists in another tab immediately while leaving unsaved notes untouched", () => {
    const qc1 = testQueryClient();
    const qc2 = testQueryClient();
    seedClientCache(qc1);
    seedClientCache(qc2);
    setNoteUnsaved(UNSAVED_NOTE_ID, true);

    setCrossTabUser(USER_ALICE);
    const tab1Echo = vi.fn();
    const unsubTab1 = onRemoteWrite(tab1Echo);

    const tab2 = createCrossTabSync();
    tab2.setCrossTabUser(USER_ALICE);
    const tab2Calls = vi.fn(() => {
      void invalidateAllExceptUnsaved(qc2);
    });
    const unsubTab2 = tab2.onRemoteWrite(tab2Calls);

    invalidateLists(qc1);

    expect(isStale(qc2, ["notes"])).toBe(true);
    expect(isStale(qc2, ["notebooks"])).toBe(true);
    expect(isStale(qc2, ["tags"])).toBe(true);
    expect(isStale(qc2, ["search", "milk"])).toBe(true);
    expect(isStale(qc2, ["note", CLEAN_NOTE_ID])).toBe(true);
    expect(isStale(qc2, ["note", UNSAVED_NOTE_ID])).toBe(false);
    // No echo back to sender and receiver does not re-announce
    expect(tab1Echo).not.toHaveBeenCalled();
    expect(FakeBroadcastChannel.posted).toHaveLength(1);

    // Rapid second write is never throttled
    invalidateLists(qc1);
    expect(tab2Calls).toHaveBeenCalledTimes(2);
    expect(tab1Echo).not.toHaveBeenCalled();

    unsubTab1();
    unsubTab2();
  });

  it("announces title/body saves from createNoteSaver to other tabs", async () => {
    const qc1 = testQueryClient();
    const qc2 = testQueryClient();
    seedClientCache(qc2);
    setCrossTabUser(USER_ALICE);

    const tab2 = createCrossTabSync();
    tab2.setCrossTabUser(USER_ALICE);
    const unsubTab2 = tab2.onRemoteWrite(() => {
      void invalidateAllExceptUnsaved(qc2);
    });

    vi.spyOn(api, "updateNote").mockResolvedValueOnce({
      id: CLEAN_NOTE_ID,
      title: "Renamed",
      body: "Updated body",
      preview: "Updated body",
      updatedTime: 2000,
      createdTime: 1000,
      parentId: NB_ID,
      notebookId: NB_ID,
      notebookTitle: "Inbox",
      tags: [],
      isTodo: false,
      todoCompleted: false,
    });

    await createNoteSaver(qc1, CLEAN_NOTE_ID, 1000).send({ title: "Renamed", body: "Updated body" });

    expect(isStale(qc2, ["notes"])).toBe(true);
    expect(isStale(qc2, ["notebooks"])).toBe(true);
    expect(isStale(qc2, ["tags"])).toBe(true);
    expect(FakeBroadcastChannel.posted).toHaveLength(1);

    unsubTab2();
  });

  it("ignores writes from other users, malformed messages and signed-out state", () => {
    const bobTab = createCrossTabSync();
    bobTab.setCrossTabUser(USER_BOB);
    const bobListener = vi.fn();
    const unsubBob = bobTab.onRemoteWrite(bobListener);

    const aliceTab = createCrossTabSync();
    aliceTab.setCrossTabUser(USER_ALICE);
    const aliceListener = vi.fn();
    const unsubAlice = aliceTab.onRemoteWrite(aliceListener);

    const signedOutListener = vi.fn();
    const unsubSignedOut = onRemoteWrite(signedOutListener);

    // Alice's write is ignored by Bob, by signed-out tabs, and by Alice's own instance
    aliceTab.announceWrite();
    expect(bobListener).not.toHaveBeenCalled();
    expect(signedOutListener).not.toHaveBeenCalled();
    expect(aliceListener).not.toHaveBeenCalled();

    // Stray/malformed message on the same channel is ignored
    const intruder = new FakeBroadcastChannel(CROSS_TAB_CHANNEL);
    intruder.postMessage(null);
    intruder.postMessage({ type: "other", user: USER_ALICE });
    expect(aliceListener).not.toHaveBeenCalled();

    // When signed out, announceWrite is a no-op
    setCrossTabUser(null);
    FakeBroadcastChannel.posted = [];
    announceWrite();
    expect(FakeBroadcastChannel.posted).toHaveLength(0);

    intruder.close();
    unsubBob();
    unsubAlice();
    unsubSignedOut();
  });

  it("wires AuthProvider to invalidate queries on remote writes while signed in", async () => {
    api.setStoredEmail("alice@example.com");
    mockFetch((call) => {
      if (call.path === "/api/auth/check") return jsonResponse({ valid: true, serverHost: "notes.example.com" });
      if (call.path === "/api/auth/logout") return jsonResponse({ message: "ok" });
      return undefined;
    });

    const authClient = testQueryClient();
    seedClientCache(authClient);
    setNoteUnsaved(UNSAVED_NOTE_ID, true);

    let logoutFn!: () => Promise<void>;
    function Probe() {
      const auth = useAuth();
      logoutFn = auth.logout;
      return <span>{auth.isAuthenticated ? "in" : "out"}</span>;
    }

    const { findByText } = render(
      <QueryClientProvider client={authClient}>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </QueryClientProvider>
    );

    await findByText("in");

    const senderTab = createCrossTabSync();
    senderTab.setCrossTabUser(USER_ALICE);
    senderTab.announceWrite();

    await waitFor(() => {
      expect(isStale(authClient, ["notes"])).toBe(true);
      expect(isStale(authClient, ["notebooks"])).toBe(true);
      expect(isStale(authClient, ["tags"])).toBe(true);
      expect(isStale(authClient, ["note", CLEAN_NOTE_ID])).toBe(true);
    });
    expect(isStale(authClient, ["note", UNSAVED_NOTE_ID])).toBe(false);

    // Different user is ignored by the authenticated tab
    authClient.clear();
    seedClientCache(authClient);
    const otherUserTab = createCrossTabSync();
    otherUserTab.setCrossTabUser(USER_BOB);
    otherUserTab.announceWrite();
    expect(isStale(authClient, ["notes"])).toBe(false);

    // After logout, remote writes no longer reach the logged-out tab
    await act(async () => {
      await logoutFn();
    });
    seedClientCache(authClient);
    senderTab.announceWrite();
    expect(isStale(authClient, ["notes"])).toBe(false);
  });

  it("is a no-op when BroadcastChannel is unavailable", () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const sync = createCrossTabSync();
    sync.setCrossTabUser(USER_ALICE);
    const unsub = sync.onRemoteWrite(vi.fn());
    expect(() => sync.announceWrite()).not.toThrow();
    expect(() => unsub()).not.toThrow();
  });
});
