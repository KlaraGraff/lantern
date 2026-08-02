import type { BookAvailabilityStatus } from "../../hooks/useBooks";

export type ReaderOpenErrorKind = "invalid-pdf" | "generic";

export interface ReaderOpenError {
  kind: ReaderOpenErrorKind;
  detail: string;
  /**
   * What the file itself turned out to be doing, filled in asynchronously by
   * `useReaderFileDiagnosis` after the failure. `undefined` means the question
   * has not been answered yet — either the probe is still running or it failed,
   * which is why the error screen has to read without it.
   */
  fileStatus?: BookAvailabilityStatus;
}

/**
 * True when the file explains the failure better than the parser error does.
 * `available` does not: the bytes were readable, so whatever went wrong is
 * about the book's contents and the original message is the better one.
 */
export function fileStatusExplainsFailure(
  status: BookAvailabilityStatus | undefined,
): status is "icloud_placeholder" | "missing" | "unreadable" {
  return status === "icloud_placeholder" || status === "missing" || status === "unreadable";
}

const INVALID_PDF_MESSAGE = /(?:invalid pdf|invalid xref|xref table|trailer dictionary|root reference|file type not supported|unexpected end.*pdf|pdf.*(?:corrupt|damaged))/i;

function errorField(error: unknown, field: "name" | "message"): string | undefined {
  if (!error || typeof error !== "object" || !(field in error)) return undefined;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function toReaderOpenError(error: unknown, format?: string | null): ReaderOpenError {
  const detail = errorField(error, "message")
    ?? (typeof error === "string" && error.trim() ? error.trim() : "READER_INIT_FAILED");
  const name = errorField(error, "name");
  const invalidPdf = format?.toLowerCase() === "pdf" && (
    name === "InvalidPDFException"
    || name === "FormatError"
    || INVALID_PDF_MESSAGE.test(detail)
  );

  return {
    kind: invalidPdf ? "invalid-pdf" : "generic",
    detail,
  };
}
