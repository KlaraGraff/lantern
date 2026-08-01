import { invoke } from "@tauri-apps/api/core";
import type { WordTiming } from "./routing";
import type { SpeechAccent } from "./types";

/** "RIFF" */
const WAV_MAGIC = [0x52, 0x49, 0x46, 0x46];

/**
 * The dictionary endpoint labels WAV payloads `audio/mpeg`, so the container is
 * sniffed from the magic bytes instead. Handing a Blob the wrong type makes
 * playback fail silently.
 */
export function audioMimeType(bytes: Uint8Array): string {
  return WAV_MAGIC.every((byte, index) => bytes[index] === byte) ? "audio/wav" : "audio/mpeg";
}

async function fetchAudio(command: string, text: string, accent: SpeechAccent): Promise<Blob> {
  const raw = await invoke<ArrayBuffer | number[]>(command, { text, accent });
  const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : Uint8Array.from(raw);
  if (bytes.byteLength === 0) throw new Error("SPEECH_EMPTY_AUDIO");
  return new Blob([bytes], { type: audioMimeType(bytes) });
}

/**
 * Rejects with `SPEECH_NOT_IN_DICTIONARY` (the corpus has no entry — routine,
 * and cached by the backend) or `SPEECH_SOURCE_UNAVAILABLE` (transport
 * failure). Both mean "fall back".
 */
export function fetchDictionaryAudio(text: string, accent: SpeechAccent): Promise<Blob> {
  return fetchAudio("speech_dictionary_audio", text, accent);
}

export interface SpokenAudio {
  blob: Blob;
  /** Empty when the source reports no timings, never absent. */
  timings: WordTiming[];
}

/**
 * Edge's Read aloud voices. Free and needs no setup, but it rides an unofficial
 * protocol, so `SPEECH_SOURCE_UNAVAILABLE` covers both an ordinary network
 * failure and Microsoft having changed or blocked the endpoint outright.
 *
 * The payload is framed rather than sent as two fields: audio crosses the IPC
 * boundary as raw bytes because a `Vec<u8>` serialized as a JSON number array
 * costs roughly four times as much, and that rules out putting it in an object
 * beside the timings.
 */
export async function fetchEdgeAudio(text: string, accent: SpeechAccent): Promise<SpokenAudio> {
  const raw = await invoke<ArrayBuffer | number[]>("speech_edge_audio", { text, accent });
  const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : Uint8Array.from(raw);
  if (bytes.byteLength < 4) throw new Error("SPEECH_EMPTY_AUDIO");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(0, false);
  const audioStart = 4 + headerLength;
  if (audioStart > bytes.byteLength) throw new Error("SPEECH_MALFORMED_AUDIO");

  const audio = bytes.subarray(audioStart);
  if (audio.byteLength === 0) throw new Error("SPEECH_EMPTY_AUDIO");

  // Timings are an enhancement, not a requirement: losing them costs the reading
  // highlight, so a malformed header must not cost the audio as well.
  let timings: WordTiming[] = [];
  if (headerLength > 0) {
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(4, audioStart)));
      if (Array.isArray(parsed)) timings = parsed as WordTiming[];
    } catch {
      timings = [];
    }
  }

  return { blob: new Blob([audio], { type: audioMimeType(audio) }), timings };
}

/**
 * The metered path. Rejects with `SPEECH_CUSTOM_NOT_CONFIGURED` when the
 * provider settings or key are missing or rejected.
 */
export function fetchCustomAudio(text: string, accent: SpeechAccent): Promise<Blob> {
  return fetchAudio("speech_custom_audio", text, accent);
}
