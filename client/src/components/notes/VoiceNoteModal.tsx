import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, RotateCcw, Square, Upload } from "lucide-react";
import { toast } from "sonner";
import { uploadResource, type UploadedResource } from "@/lib/api";
import { announceWrite } from "@/lib/cross-tab";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface VoiceNoteModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUploaded: (resource: UploadedResource) => void;
}

function defaultVoiceTitle(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `Voice note ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}`;
}

function pickAudioMimeType(): string {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "audio/webm";
  }
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function extensionForMime(mime: string): string {
  const lower = mime.toLowerCase();
  if (lower.includes("mp4") || lower.includes("m4a")) return "m4a";
  if (lower.includes("ogg")) return "ogg";
  if (lower.includes("wav")) return "wav";
  return "webm";
}

export function VoiceNoteModal({ open, onOpenChange, onUploaded }: VoiceNoteModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mic className="h-4 w-4 text-primary" aria-hidden="true" />
            Record Voice Note
          </DialogTitle>
          <DialogDescription>
            Record audio from your microphone and attach it directly to your note.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <VoiceNoteRecorder
            onClose={() => onOpenChange(false)}
            onUploaded={onUploaded}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function VoiceNoteRecorder({
  onClose,
  onUploaded,
}: {
  onClose: () => void;
  onUploaded: (resource: UploadedResource) => void;
}) {
  const supported =
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== "undefined";

  const [recording, setRecording] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [title, setTitle] = useState(defaultVoiceTitle);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<number | null>(null);

  const stopTimer = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const stopStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        try {
          mediaRecorderRef.current.stop();
        } catch {
          // ignore cleanup stop errors
        }
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  const startRecording = async () => {
    if (!supported) {
      setError("Audio recording is not supported in this browser.");
      return;
    }
    setError(null);
    setRecordedBlob(null);
    setAudioUrl(null);
    setElapsedSec(0);
    chunksRef.current = [];

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickAudioMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        stopTimer();
        stopStream();
        const type = recorder.mimeType || mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        setRecordedBlob(blob);
        if (blob.size > 0) {
          setAudioUrl(URL.createObjectURL(blob));
        }
        setRecording(false);
      };

      recorder.onerror = () => {
        stopTimer();
        stopStream();
        setRecording(false);
        setError("Recording stopped unexpectedly due to a microphone error.");
      };

      recorder.start(250);
      setRecording(true);
      timerRef.current = window.setInterval(() => {
        setElapsedSec((prev) => prev + 1);
      }, 1000);
    } catch (err) {
      stopStream();
      setError(
        err instanceof Error
          ? err.message || "Microphone access was denied."
          : "Could not access the microphone."
      );
    }
  };

  const stopRecording = () => {
    stopTimer();
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    } else {
      stopStream();
      setRecording(false);
    }
  };

  const handleUpload = async () => {
    if (!recordedBlob || recordedBlob.size === 0) return;
    setUploading(true);
    setError(null);
    try {
      const cleanTitle = (title.trim() || defaultVoiceTitle()).replace(/[\\/:*?"<>|]/g, "-");
      const mime = recordedBlob.type || "audio/webm";
      const ext = extensionForMime(mime);
      const fileName = cleanTitle.toLowerCase().endsWith(`.${ext}`) ? cleanTitle : `${cleanTitle}.${ext}`;
      const file = new File([recordedBlob], fileName, { type: mime });
      const resource = await uploadResource(file);
      announceWrite();
      onUploaded(resource);
      toast.success("Voice note uploaded");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not upload voice recording.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-4">
      {!supported && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
          Microphone recording via MediaRecorder is unavailable in this browser context.
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="rounded-xl border border-border bg-muted/30 p-4 flex flex-col items-center justify-center gap-3">
        <div className="flex items-center gap-2 font-mono text-2xl font-semibold text-foreground">
          {recording && <span className="h-2.5 w-2.5 rounded-full bg-destructive animate-pulse" aria-hidden="true" />}
          <span>{formatDuration(elapsedSec)}</span>
        </div>

        <div className="flex items-center gap-2">
          {!recording ? (
            <Button
              type="button"
              onClick={() => void startRecording()}
              disabled={!supported || uploading}
              className="gap-1.5"
            >
              {recordedBlob ? <RotateCcw className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              {recordedBlob ? "Re-record" : "Start recording"}
            </Button>
          ) : (
            <Button type="button" variant="destructive" onClick={stopRecording} className="gap-1.5">
              <Square className="h-3.5 w-3.5 fill-current" />
              Stop
            </Button>
          )}
        </div>
      </div>

      {audioUrl && recordedBlob && (
        <div className="space-y-3">
          <audio controls src={audioUrl} className="w-full" />
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Recording title</span>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Voice note title"
              disabled={uploading}
            />
          </label>
        </div>
      )}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose} disabled={uploading}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={() => void handleUpload()}
          disabled={!recordedBlob || recordedBlob.size === 0 || recording || uploading}
          className="gap-1.5"
        >
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          Upload & insert
        </Button>
      </DialogFooter>
    </div>
  );
}
