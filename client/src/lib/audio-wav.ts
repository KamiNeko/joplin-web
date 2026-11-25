const TARGET_SAMPLE_RATE = 16000;

/**
 * Encodes a mono [-1, 1] float PCM array into a 16-bit PCM RIFF/WAVE ArrayBuffer.
 */
export function encodeMonoPcmWav(samples: Float32Array, sampleRate = TARGET_SAMPLE_RATE): ArrayBuffer {
  const byteLength = 44 + samples.length * 2;
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // IEEE format = 1 (PCM)
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate = sampleRate * numChannels * bitsPerSample/8
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return buffer;
}

/**
 * Mixes an AudioBuffer to mono and resamples linearly to 16 kHz for speech transcription.
 */
export function downsampleToMono16k(audioBuffer: AudioBuffer): Float32Array {
  const numChannels = Math.max(1, audioBuffer.numberOfChannels);
  const length = audioBuffer.length;
  const mono = new Float32Array(length);

  for (let ch = 0; ch < numChannels; ch++) {
    const channelData = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] += channelData[i] / numChannels;
    }
  }

  const srcRate = audioBuffer.sampleRate;
  if (!srcRate || srcRate === TARGET_SAMPLE_RATE || length === 0) {
    return mono;
  }

  const targetLength = Math.max(1, Math.round((length * TARGET_SAMPLE_RATE) / srcRate));
  const resampled = new Float32Array(targetLength);
  const ratio = srcRate / TARGET_SAMPLE_RATE;

  for (let i = 0; i < targetLength; i++) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const s0 = mono[Math.min(idx, length - 1)];
    const s1 = mono[Math.min(idx + 1, length - 1)];
    resampled[i] = s0 + (s1 - s0) * frac;
  }

  return resampled;
}

/**
 * Decodes recorded browser audio via Web Audio API and encodes it as a compact 16 kHz mono WAV.
 * Falls back to the original blob if Web Audio decoding is unavailable.
 */
export async function convertAudioBlobToWav(blob: Blob): Promise<{ blob: Blob; mime: string }> {
  const cleanMime = (blob.type || "").split(";")[0].trim().toLowerCase();
  if (typeof window === "undefined") {
    return { blob, mime: cleanMime || "audio/webm" };
  }
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) {
    return { blob, mime: cleanMime || "audio/webm" };
  }

  let ctx: AudioContext | null = null;
  try {
    ctx = new AudioCtx();
    const arrayBuffer = await blob.arrayBuffer();
    const decoded = await ctx.decodeAudioData(arrayBuffer);
    const samples = downsampleToMono16k(decoded);
    const wavBuffer = encodeMonoPcmWav(samples, TARGET_SAMPLE_RATE);
    return {
      blob: new Blob([wavBuffer], { type: "audio/wav" }),
      mime: "audio/wav",
    };
  } catch {
    return { blob, mime: cleanMime || "audio/webm" };
  } finally {
    if (ctx && typeof ctx.close === "function") {
      await ctx.close().catch(() => undefined);
    }
  }
}
