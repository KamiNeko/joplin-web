import { describe, expect, it } from "vitest";
import { convertAudioBlobToWav, downsampleToMono16k, encodeMonoPcmWav } from "./audio-wav";

function readAscii(view: DataView, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(view.getUint8(offset + i));
  }
  return out;
}

describe("audio-wav helpers", () => {
  it("encodes mono 16-bit PCM WAV headers and clamped samples", () => {
    const samples = new Float32Array([-1.5, -0.5, 0, 0.5, 1.5]);
    const buffer = encodeMonoPcmWav(samples, 16000);
    const view = new DataView(buffer);

    expect(buffer.byteLength).toBe(44 + samples.length * 2);
    expect(readAscii(view, 0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + samples.length * 2);
    expect(readAscii(view, 8, 4)).toBe("WAVE");
    expect(readAscii(view, 12, 4)).toBe("fmt ");
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(readAscii(view, 36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(samples.length * 2);

    expect(view.getInt16(44, true)).toBe(-32768);
    expect(view.getInt16(48, true)).toBe(0);
    expect(view.getInt16(52, true)).toBe(32767);
  });

  it("mixes stereo AudioBuffer to mono and downsamples to 16 kHz", () => {
    const left = new Float32Array(48);
    const right = new Float32Array(48);
    left.fill(0.8);
    right.fill(0.2);

    const mockAudioBuffer = {
      numberOfChannels: 2,
      length: 48,
      sampleRate: 48000,
      getChannelData: (ch: number) => (ch === 0 ? left : right),
    } as unknown as AudioBuffer;

    const mono16k = downsampleToMono16k(mockAudioBuffer);
    expect(mono16k).toHaveLength(16);
    for (const s of mono16k) {
      expect(s).toBeCloseTo(0.5, 4);
    }
  });

  it("falls back to original blob when AudioContext is unavailable", async () => {
    const original = new Blob(["webm-bytes"], { type: "audio/webm;codecs=opus" });
    const res = await convertAudioBlobToWav(original);
    expect(res.blob).toBe(original);
    expect(res.mime).toBe("audio/webm");
  });
});
