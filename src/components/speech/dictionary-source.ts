import { invoke } from "@tauri-apps/api/core";
import type { SpeechAccent } from "./types";

/** "RIFF" */
const WAV_MAGIC = [0x52, 0x49, 0x46, 0x46];

/**
 * The endpoint labels WAV payloads `audio/mpeg`, so the container is sniffed
 * from the magic bytes instead. Handing a Blob the wrong type makes playback
 * fail silently.
 */
export function audioMimeType(bytes: Uint8Array): string {
  return WAV_MAGIC.every((byte, index) => bytes[index] === byte) ? "audio/wav" : "audio/mpeg";
}

/**
 * Resolves with dictionary audio, or rejects with `SPEECH_NOT_IN_DICTIONARY`
 * (the corpus has no entry — expected, and cached by the backend) or
 * `SPEECH_SOURCE_UNAVAILABLE` (transport failure). Both mean "fall back".
 */
export async function fetchDictionaryAudio(text: string, accent: SpeechAccent): Promise<Blob> {
  const raw = await invoke<ArrayBuffer | number[]>("speech_dictionary_audio", { text, accent });
  const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : Uint8Array.from(raw);
  if (bytes.byteLength === 0) throw new Error("SPEECH_NOT_IN_DICTIONARY");
  return new Blob([bytes], { type: audioMimeType(bytes) });
}
