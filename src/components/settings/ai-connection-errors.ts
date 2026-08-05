/**
 * Connection-test error labelling, shared by the Settings service card and the
 * first-launch onboarding step. Kept out of `AiServiceCard.tsx` so that file
 * exports only its component — a module that mixes components with plain
 * constants loses fast refresh for everything in it.
 */

/** Backend `error_kind` → the `settings.ai.testError.*` suffix that names it. */
export const CONNECTION_ERROR_KEYS: Record<string, string> = {
  credential_invalid: "credentialInvalid",
  auth: "auth",
  permission: "permission",
  rate_limit: "rateLimit",
  quota: "quota",
  network: "network",
  provider_5xx: "provider5xx",
  protocol: "protocol",
  request: "request",
  not_configured: "notConfigured",
  cancelled: "cancelled",
};

/** Falls back to the raw `kind` rather than a generic message, so an error the
 * backend grows before this table does still tells the user something. */
export function connectionErrorLabel(
  kind: string | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const key = kind ? CONNECTION_ERROR_KEYS[kind] : undefined;
  return key ? t(`settings.ai.testError.${key}`) : (kind ?? t("settings.ai.unknownError"));
}
