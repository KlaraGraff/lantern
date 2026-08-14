/**
 * The dialog plugin hands back a plain filesystem path on desktop, but on iOS
 * the picker is a Swift `URL` and arrives as a `file://` string instead — the
 * photo or document is copied into the app's Caches directory and reported as
 * `file:///.../Library/Caches/IMG_0111.jpeg`. Anything that treats that string
 * as a path fails: the Rust side gets ENOENT from `fs::metadata`, and
 * `convertFileSrc` builds an asset URL out of the escaped `file%3A%2F%2F…`
 * which the protocol handler cannot resolve, so the preview renders as a broken
 * image.
 *
 * Normalising here rather than at each call site keeps the two platforms on one
 * shape: a path the backend can open and the asset protocol can serve. The
 * dialog plugin has already granted that same resolved path to the asset scope,
 * so the preview is allowed once the string is in the right form.
 */
export function pickedFilePath(selected: string): string {
  if (!selected.startsWith("file://")) return selected;
  try {
    // `pathname` is still percent-encoded — a photo named "My Pic.jpeg" comes
    // back as "My%20Pic.jpeg" and would miss the file on disk.
    return decodeURIComponent(new URL(selected).pathname);
  } catch {
    return selected;
  }
}
