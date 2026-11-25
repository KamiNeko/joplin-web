import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { FetchCall, jsonResponse, mockFetch } from "@/test/fetch-mock";
import { VoiceNoteModal } from "./VoiceNoteModal";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() },
}));

function stubMediaRecorder(blobBytes = "voice-bytes", mimeType = "audio/webm") {
  class FakeMediaRecorder {
    static isTypeSupported = () => true;
    mimeType = mimeType;
    state: RecordingState = "inactive";
    ondataavailable: ((ev: BlobEvent) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;

    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob([blobBytes], { type: mimeType }) } as BlobEvent);
      this.onstop?.();
    }
  }

  const trackStop = vi.fn();
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("navigator", {
    ...navigator,
    mediaDevices: {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [{ stop: trackStop }],
      })),
    },
  });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:voice-preview");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
}

function renderModal(onUploaded = vi.fn(), onOpenChange = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <VoiceNoteModal open onOpenChange={onOpenChange} onUploaded={onUploaded} />
    </QueryClientProvider>
  );
  return { onUploaded, onOpenChange };
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("VoiceNoteModal transcription flow", () => {
  it("shows AI transcription toggle when enabled, transcribes recording, and passes transcript to onUploaded", async () => {
    stubMediaRecorder();
    const resId = "a".repeat(32);
    const calls: FetchCall[] = mockFetch((call) => {
      if (call.path === "/api/ai/status") {
        return jsonResponse({ enabled: true, model: "gemini-flash", transcribeEnabled: true, transcribeModel: "gemini-3.8-flash" });
      }
      if (call.method === "POST" && call.path === "/api/resources") {
        return jsonResponse({ id: resId, title: "Voice note", mime: "audio/webm", size: 11 }, 201);
      }
      if (call.method === "POST" && call.path === "/api/ai/transcribe") {
        return jsonResponse({ text: "Action item: send deck tomorrow.", model: "gemini-3.8-flash" });
      }
      return undefined;
    });

    const onUploaded = vi.fn();
    renderModal(onUploaded);

    await waitFor(() => expect(calls.some((c) => c.path === "/api/ai/status")).toBe(true));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    });

    const toggle = (await screen.findByRole("checkbox", { name: /Transcribe speech with AI/i })) as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Upload & insert" }));

    await waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(1));
    expect(onUploaded).toHaveBeenCalledWith({
      id: resId,
      title: "Voice note",
      mime: "audio/webm",
      size: 11,
      transcript: "Action item: send deck tomorrow.",
    });
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/ai/transcribe")).toBe(true);
  });

  it("still inserts uploaded audio gracefully when transcription fails", async () => {
    stubMediaRecorder();
    const resId = "b".repeat(32);
    mockFetch((call) => {
      if (call.path === "/api/ai/status") {
        return jsonResponse({ enabled: true, transcribeEnabled: true, transcribeModel: "gemini-3.8-flash" });
      }
      if (call.method === "POST" && call.path === "/api/resources") {
        return jsonResponse({ id: resId, title: "Voice memo", mime: "audio/webm", size: 11 }, 201);
      }
      if (call.method === "POST" && call.path === "/api/ai/transcribe") {
        return jsonResponse({ error: "Upstream unavailable" }, 502);
      }
      return undefined;
    });

    const onUploaded = vi.fn();
    renderModal(onUploaded);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    });
    fireEvent.click(await screen.findByRole("button", { name: "Upload & insert" }));

    await waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(1));
    expect(onUploaded.mock.calls[0][0]).toEqual({
      id: resId,
      title: "Voice memo",
      mime: "audio/webm",
      size: 11,
    });
    expect(toast.warning).toHaveBeenCalled();
  });

  it("hides transcription checkbox when transcribeEnabled is false", async () => {
    stubMediaRecorder();
    mockFetch((call) => {
      if (call.path === "/api/ai/status") {
        return jsonResponse({ enabled: false, transcribeEnabled: false });
      }
      return undefined;
    });

    renderModal();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    });

    expect(await screen.findByLabelText("Recording title")).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /Transcribe speech with AI/i })).toBeNull();
  });
});
