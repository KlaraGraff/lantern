import { invoke } from "@tauri-apps/api/core";
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

/**
 * Edge's Read aloud voices. Free and needs no setup, but it rides an unofficial
 * protocol, so `SPEECH_SOURCE_UNAVAILABLE` covers both an ordinary network
 * failure and Microsoft having changed or blocked the endpoint outright.
 */
export function fetchEdgeAudio(text: string, accent: SpeechAccent): Promise<Blob> {
  return fetchAudio("speech_edge_audio", text, accent);
}

/**
 * The metered path. Rejects with `SPEECH_CUSTOM_NOT_CONFIGURED` when the
 * provider settings or key are missing or rejected.
 */
export function fetchCustomAudio(text: string, accent: SpeechAccent): Promise<Blob> {
  return fetchAudio("speech_custom_audio", text, accent);
}
