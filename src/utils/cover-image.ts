/**
 * What the cover picker offers. The backend stores every one of them as a
 * JPEG, so anything that is not already a JPEG is previewed from that
 * converted copy: it shows what will be saved (transparency turns white), and
 * webviews other than Safari cannot draw a TIFF or a HEIC at all.
 */
export const COVER_IMAGE_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "bmp",
  "tif",
  "tiff",
  "heic",
  "heif",
];

export function needsConvertedPreview(path: string): boolean {
  return !/\.jpe?g$/i.test(path);
}
