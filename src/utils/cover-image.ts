/**
 * What the cover picker offers. HEIC is decoded by the backend (it is what an
 * iPhone saves photos as), so only those files go through a converted preview:
 * outside Apple's webview an `<img>` cannot draw one.
 */
export const COVER_IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "heic", "heif"];

export function isHeicPath(path: string): boolean {
  return /\.hei[cf]$/i.test(path);
}
