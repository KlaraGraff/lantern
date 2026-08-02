/**
 * Built-in model presets.
 *
 * A preset is only what Lantern knows about a provider up front — endpoint,
 * default model, how it bills, where the user creates a key. It carries no
 * credentials: the user always brings their own key, and Lantern never ships a
 * shared one.
 *
 * Cost is deliberately not part of the display name. A profile's name is copied
 * into the user's own configuration when they add it and later updates may not
 * rewrite it, so a name promising "free" could neither be corrected nor kept
 * honest if the provider changed its terms. Pricing lives in a chip instead,
 * which is presentation and can change with the app.
 */

/** Zhipu's mainland endpoint. Already carries its `/v4` version segment. */
export const ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";

/** Zhipu's free tier model. Verified against their docs on 2026-08-02. */
export const ZHIPU_DEFAULT_MODEL = "glm-4.7-flash";

/** Where the user creates their own key. Opened in the system browser. */
export const ZHIPU_API_KEY_PAGE = "https://bigmodel.cn/usercenter/proj-mgmt/apikeys";
