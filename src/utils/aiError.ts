export const AI_ERROR_CODES = [
  "AI_NOT_CONFIGURED",
  "AI_KEYS_DISABLED",
  "AI_ALL_KEYS_INVALID",
  "AI_KEYS_COOLING_DOWN",
  "AI_NO_USABLE_KEYS",
  "AI_STREAM_FAILED",
  // 词卷「出题模型」硬指定的 profile 被停用/删除（router.rs pin_profile）。
  // 只有带 profileId 的调用（quiz/transport.ts）可能收到，其余功能不会。
  "AI_PROFILE_NOT_AVAILABLE",
] as const;

export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

const AI_SETTINGS_ERROR_CODES = new Set<AiErrorCode>([
  "AI_NOT_CONFIGURED",
  "AI_KEYS_DISABLED",
  "AI_ALL_KEYS_INVALID",
  "AI_KEYS_COOLING_DOWN",
  "AI_NO_USABLE_KEYS",
  "AI_PROFILE_NOT_AVAILABLE",
]);

export function getAiErrorCode(error: unknown): AiErrorCode | null {
  const message = String(error);
  return AI_ERROR_CODES.find((code) => message.includes(code)) ?? null;
}

export function isAiErrorCode(value: unknown): value is AiErrorCode {
  return typeof value === "string" && AI_ERROR_CODES.includes(value as AiErrorCode);
}

export function isAiSettingsError(code: AiErrorCode | null): boolean {
  return code !== null && AI_SETTINGS_ERROR_CODES.has(code);
}

/**
 * Failures worth offering a retry for: the route was there and something went
 * wrong anyway. The rest need a settings change first, and a retry button on
 * those would only invite the user to press it until they give up.
 */
const AI_RETRYABLE_ERROR_CODES = new Set<AiErrorCode>([
  "AI_KEYS_COOLING_DOWN",
  "AI_STREAM_FAILED",
]);

export function isAiRetryableError(code: AiErrorCode | null): boolean {
  return code !== null && AI_RETRYABLE_ERROR_CODES.has(code);
}

export function aiErrorMessageKey(code: AiErrorCode): string {
  switch (code) {
    case "AI_NOT_CONFIGURED":
      return "ai.notConfigured";
    case "AI_KEYS_DISABLED":
      return "ai.keysDisabled";
    case "AI_ALL_KEYS_INVALID":
      return "ai.allKeysInvalid";
    case "AI_KEYS_COOLING_DOWN":
      return "ai.keysCoolingDown";
    case "AI_NO_USABLE_KEYS":
      return "ai.noUsableKeys";
    case "AI_STREAM_FAILED":
      return "ai.requestFailed";
    case "AI_PROFILE_NOT_AVAILABLE":
      return "quiz.error.profileUnavailable";
  }
}
