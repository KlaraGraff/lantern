/**
 * Clipboard writes fail more often on a phone than on a desktop: WKWebView only
 * grants `navigator.clipboard` inside a real user gesture, and anything that
 * awaits before calling it (or runs from a timer) loses that grant and gets a
 * rejected promise instead of an exception. Call sites that fire and forget
 * therefore end up flashing "copied" over a clipboard that still holds whatever
 * was there before.
 *
 * Resolves to whether the text actually landed, so the caller can hold its
 * confirmation back.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.error("Failed to copy to clipboard:", error);
    return false;
  }
}

/**
 * How long a "copied" tick stays before the button goes back to "copy". Long
 * enough to be seen after the eye returns from wherever the text was pasted,
 * short enough that a stale tick never claims the clipboard still holds it.
 * One number for every copy button, so none of them lingers longer than the
 * rest.
 */
export const COPIED_FEEDBACK_MS = 2500;
