export type ReaderOpenErrorKind = "invalid-pdf" | "generic";

export interface ReaderOpenError {
  kind: ReaderOpenErrorKind;
  detail: string;
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
