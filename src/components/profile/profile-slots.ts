import { BookMarked, Languages, MessagesSquare, PenLine, ScanSearch, Sparkles, Timer } from "lucide-react";
import { PROFILE_SLOTS, type ProfileSlot } from "../../hooks/useProfile";

/**
 * Display order + icon for the seven fixed dimensions
 * (`docs/impls/user-profile.md` §2). The order here is what renders in the
 * system section — it mirrors `PROFILE_SLOTS`'s declaration order, which is
 * itself the mockup's order (词义/句法/指代/文化背景/查词取向/举例来源/回答节奏).
 * Display names live in i18n under `profile.slot.<key>`, never here — the
 * zh names are pinned exactly by the spec and must not drift.
 */
export const PROFILE_SLOT_ICONS: Record<ProfileSlot, typeof Sparkles> = {
  vocab_explain: Languages,
  syntax_explain: PenLine,
  reference_explain: MessagesSquare,
  cultural_context: BookMarked,
  lookup_pattern: ScanSearch,
  example_source: Sparkles,
  reply_pacing: Timer,
};

export function profileSlotOrder(): readonly ProfileSlot[] {
  return PROFILE_SLOTS;
}
