/**
 * "Added from the catalog, never filled in" — which rows are a configuration
 * and which are still a blank the reader walked away from.
 *
 * Picking a model from the catalog writes the row immediately, and it has to:
 * the card asks the endpoint which models it serves, and that question goes
 * through the profile, so the profile exists before anyone knows its answer.
 * LM Studio and a custom endpoint arrive with no model name at all — nobody but
 * the reader's own machine knows what it is running — so the backend accepts a
 * half-built row rather than refusing the add.
 *
 * The cost of that is a row that names nothing and can answer nothing, sitting
 * in the route list. Two rules pay it back, and they live here rather than in
 * the component because both decide whether something is written down or taken
 * away, which is worth stating once and testing directly:
 *
 * - nothing incomplete is ever persisted past the row itself, and
 * - a row added in this sitting and left incomplete is removed again.
 */

import { AI_PRESETS } from "./aiPresets.ts";

/** As much of a profile as these two decisions read. */
export interface ProfileConfig {
  id: string;
  label: string;
  provider: string;
  auth_mode: string;
  base_url: string | null;
  model: string;
  temperature: number;
}

/**
 * Whether this configuration is finished enough to be worth writing down.
 *
 * Validated against the whole catalog, not against the presets this platform
 * offers. A model configured on a Mac can name a provider a phone would not
 * offer — an Ollama route synced across is the case — and that profile is still
 * valid data. Refusing to save it would mean a phone silently corrupting a
 * route it merely cannot run.
 */
export function isProfileConfigComplete(profile: ProfileConfig): boolean {
  const label = profile.label.trim();
  const model = profile.model.trim();
  if (!label || Array.from(label).length > 100) return false;
  if (!model || Array.from(model).length > 200) return false;
  if (!Number.isFinite(profile.temperature) || profile.temperature < 0 || profile.temperature > 2) return false;
  if (!AI_PRESETS.some((preset) => preset.provider === profile.provider)) return false;
  if (profile.auth_mode === "oauth" && profile.provider !== "openai") return false;
  const baseUrl = profile.base_url?.trim();
  if (profile.provider === "custom" && !baseUrl) return false;
  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      if (!(["http:", "https:"] as string[]).includes(parsed.protocol) || !parsed.hostname) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export interface AbandonedDraftQuery {
  /** Every row currently on screen, drafts included. */
  profiles: readonly ProfileConfig[];
  /** Rows added from the catalog in this sitting that never became usable. */
  drafts: ReadonlySet<string>;
  /** The card still open, which is the one being worked on. `null` when none is. */
  keepId: string | null;
  /** How many keys each row holds, by id. */
  credentialCount: (id: string) => number;
}

/**
 * The rows to take back, because they were added and then left blank.
 *
 * Deliberately narrow. Only a row added in this sitting qualifies — a blank row
 * that was already there when the pane opened survived a previous session and
 * is not ours to guess about. And a row holding a key is never removed, however
 * incomplete the rest of it is: a pasted key is the one thing here the reader
 * cannot get back by clicking the same catalog entry again.
 */
export function abandonedDraftIds(query: AbandonedDraftQuery): string[] {
  return query.profiles
    .filter((profile) => (
      query.drafts.has(profile.id)
      && profile.id !== query.keepId
      && !isProfileConfigComplete(profile)
      && query.credentialCount(profile.id) === 0
    ))
    .map((profile) => profile.id);
}
