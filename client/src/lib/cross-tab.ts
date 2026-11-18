/**
 * Cross-tab cache synchronization over BroadcastChannel. When one tab completes a write, other
 * open tabs on the same origin signed in as the same user refresh immediately instead of waiting
 * for tab focus or the auto-refresh interval. Falls back to a no-op where BroadcastChannel is
 * unavailable.
 */

export const CROSS_TAB_CHANNEL = "joplin-web:cross-tab";

export interface CrossTabMessage {
  type: "write";
  /** Account + server identity (`draftOwner`), so another user's writes are ignored */
  user: string;
  /** Unique to one sync instance so even a naive BroadcastChannel never echoes back to self */
  sender: string;
}

export interface CrossTabSync {
  /** Sets the active session's user/server key (or null when signed out). */
  setCrossTabUser: (user: string | null) => void;
  /** Broadcasts to other tabs of the same user that a write succeeded. */
  announceWrite: () => void;
  /** Subscribes to write notifications from other tabs of the same user. */
  onRemoteWrite: (callback: () => void) => () => void;
}

function makeSenderId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function openBroadcastChannel(name: string): BroadcastChannel | null {
  if (typeof globalThis.BroadcastChannel !== "function") return null;
  try {
    return new globalThis.BroadcastChannel(name);
  } catch {
    return null;
  }
}

function isWriteMessage(data: unknown): data is CrossTabMessage {
  if (typeof data !== "object" || data === null) return false;
  const candidate = data as Record<string, unknown>;
  return (
    candidate.type === "write" &&
    typeof candidate.user === "string" &&
    candidate.user.length > 0 &&
    typeof candidate.sender === "string"
  );
}

/**
 * Creates an isolated cross-tab sync coordinator (one per browser tab; tests instantiate one per
 * simulated tab against a shared fake BroadcastChannel).
 */
export function createCrossTabSync(channelName = CROSS_TAB_CHANNEL): CrossTabSync {
  const senderId = makeSenderId();
  let currentUser: string | null = null;
  let channel: BroadcastChannel | null = null;
  const listeners = new Set<() => void>();

  const handleMessage = (event: MessageEvent<unknown>) => {
    if (!currentUser || !isWriteMessage(event.data)) return;
    if (event.data.user !== currentUser || event.data.sender === senderId) return;
    // Snapshot first in case a listener unsubscribes itself during notification
    [...listeners].forEach((listener) => listener());
  };

  const ensureChannel = (): BroadcastChannel | null => {
    if (channel) return channel;
    const opened = openBroadcastChannel(channelName);
    if (!opened) return null;
    opened.addEventListener("message", handleMessage);
    channel = opened;
    return opened;
  };

  const releaseChannelIfUnused = () => {
    if (listeners.size > 0 || !channel) return;
    try {
      channel.removeEventListener("message", handleMessage);
      channel.close();
    } catch {
      // ignore channel close errors in restricted contexts
    }
    channel = null;
  };

  return {
    setCrossTabUser(user) {
      currentUser = user && user.length > 0 ? user : null;
    },

    announceWrite() {
      if (!currentUser) return;
      const message: CrossTabMessage = {
        type: "write",
        user: currentUser,
        sender: senderId,
      };
      if (channel) {
        try {
          channel.postMessage(message);
        } catch {
          // ignore closed or unavailable channel errors
        }
        return;
      }
      const temp = openBroadcastChannel(channelName);
      if (!temp) return;
      try {
        temp.postMessage(message);
      } catch {
        // ignore post errors
      } finally {
        try {
          temp.close();
        } catch {
          // ignore close errors
        }
      }
    },

    onRemoteWrite(callback) {
      listeners.add(callback);
      ensureChannel();
      return () => {
        listeners.delete(callback);
        releaseChannelIfUnused();
      };
    },
  };
}

const defaultCrossTabSync = createCrossTabSync();

/** Sets the current tab's signed-in user/server key (or null on sign-out). */
export function setCrossTabUser(user: string | null): void {
  defaultCrossTabSync.setCrossTabUser(user);
}

/** Announces to other tabs of the same user that a write succeeded. */
export function announceWrite(): void {
  defaultCrossTabSync.announceWrite();
}

/** Subscribes to write announcements from other tabs of the same user. */
export function onRemoteWrite(callback: () => void): () => void {
  return defaultCrossTabSync.onRemoteWrite(callback);
}
