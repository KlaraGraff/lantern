/**
 * Mock of `@tauri-apps/plugin-fs`, backed by an in-memory map so a
 * write-then-read round-trip inside one sweep behaves.
 */
import { recordNative } from "../state";

const files = new Map<string, string>();

export async function readTextFile(path: string): Promise<string> {
  recordNative(`fs.readTextFile(${path})`);
  const contents = files.get(path);
  if (contents === undefined) throw new Error(`harness: no such file: ${path}`);
  return contents;
}

export async function writeTextFile(path: string, contents: string): Promise<void> {
  recordNative(`fs.writeTextFile(${path})`);
  files.set(path, contents);
}

export async function exists(path: string): Promise<boolean> {
  return files.has(path);
}

export async function readFile(path: string): Promise<Uint8Array> {
  return new TextEncoder().encode(await readTextFile(path));
}

export async function writeFile(path: string, data: Uint8Array): Promise<void> {
  await writeTextFile(path, new TextDecoder().decode(data));
}

export async function mkdir(): Promise<void> {}
export async function remove(path: string): Promise<void> {
  files.delete(path);
}
export const BaseDirectory = { AppData: 1, AppConfig: 2, Document: 3, Download: 4 } as const;
