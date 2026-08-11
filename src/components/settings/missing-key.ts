/**
 * "The model is here, its key is not" — which state this device is in, and
 * how long it has been there.
 *
 * Two independent channels carry a model to a second device today: its name,
 * provider and endpoint ride the iCloud Documents container along with the
 * library, and that one arrives. Its credential does not ride anything —
 * Lantern keeps every API key and OAuth token in one local `secrets.db` that
 * never leaves the device it was entered on (see `src-tauri/src/secrets.rs`'s
 * module comment: "one table, one file, no operating-system credential
 * store"). There is no synchronizable Keychain item: the `keyring` crate was
 * removed from `Cargo.toml` in v2.6.0, and nothing in this codebase calls
 * `SecItemAdd`/`SecItemCopyMatching`. So a key "not arriving" is not a fault
 * to diagnose on any platform — it was never going to arrive. The copy says
 * exactly that and sends the reader to type it in again, here.
 *
 * The state machine below — `waiting` / `inferred` / `alone`, the grace
 * window, reading `sync_status` for a named peer — predates that correction.
 * It used to carry an inference ("the other channel delivered and this one
 * didn't, so your iCloud Keychain switch is probably off") that a real
 * synced-credential channel would have made true. That inference is gone
 * from the rendered copy because it is false for every reader today; see
 * MissingKeyNotice.tsx for exactly what each state still shows. The
 * machinery itself stays: the day a synced-credential channel ships, these
 * are the same three states and the same clock that reasoning will need
 * again, and rebuilding it from scratch would just reproduce this file.
 */

import { isLocalModelServerProvider } from "./aiPresets.ts";

/** As much of `sync_status`'s peer as this decision reads. */
export interface MissingKeyPeer {
  name: string;
  last_seen: number;
}

export type MissingKeyState =
  /** Nothing to say: there is a key, or this profile does not use keys. */
  | { kind: "none" }
  /** Under the grace window since this device first noticed the key
   *  missing. Renders the same base copy as `alone` (MissingKeyNotice.tsx
   *  adds nothing extra for either) — the distinction is kept only so the
   *  window has something to gate once inference-bearing copy comes back. */
  | { kind: "waiting" }
  /** A named peer proves the document-sync channel is delivering from that
   *  device. Contributes one factual aside naming it; draws no conclusion
   *  about the key, which never rode that channel or any other. */
  | { kind: "inferred"; peer: string }
  /** No named peer to point to — no document-sync pairing, no peers seen
   *  yet, or a peer with no name to print. Renders the same base copy as
   *  `waiting`. */
  | { kind: "alone" };

/**
 * How long the pane withholds the `inferred` peer-provenance aside.
 *
 * Kept at the value D-018 originally chose to avoid a premature accusation —
 * a sentence this pane no longer states at all. Preserved so a future
 * synced-credential feature inherits the same window instead of re-deriving
 * it; today all it delays is a harmless factual mention, not a conclusion.
 */
export const KEYCHAIN_GRACE_MS = 60_000;

export interface MissingKeyInput {
  /** This profile authenticates with API keys and has none on this device. */
  missing: boolean;
  /**
   * This platform is on the iCloud document-sync pair — the one place a
   * peer's name is ever available to mention. Windows never joins that sync
   * and has no peer to name either, so it always resolves to `alone`.
   */
  pairedSync: boolean;
  peers: MissingKeyPeer[];
  /** When this device first saw the key to be missing, epoch ms. */
  observedSince: number;
  now: number;
}

/**
 * The most recently seen peer that has a name to print. An unnamed peer is
 * still evidence the document channel works, but "a device you own" reads as
 * evasion where the whole point is to name what was observed — so it falls back
 * to the plain wording rather than half-naming anything.
 */
function namedPeer(peers: MissingKeyPeer[]): string | null {
  const named = peers.filter((peer) => peer.name.trim().length > 0);
  if (named.length === 0) return null;
  return named.reduce((best, peer) => (peer.last_seen > best.last_seen ? peer : best)).name.trim();
}

export function missingKeyState(input: MissingKeyInput): MissingKeyState {
  if (!input.missing) return { kind: "none" };
  const peer = input.pairedSync ? namedPeer(input.peers) : null;
  if (!peer) return { kind: "alone" };
  if (input.now - input.observedSince < KEYCHAIN_GRACE_MS) return { kind: "waiting" };
  return { kind: "inferred", peer };
}

/**
 * Whether a profile is in the state this pane is about at all: it wants a key
 * and this device has none. A model that authenticates with an account, or with
 * nothing, is never missing a key — it is unconfigured, which the card already
 * says in its own words.
 */
export function wantsMissingKeyNotice(
  profile: { auth_mode: string; provider: string },
  credentialCount: number,
): boolean {
  if (profile.auth_mode !== "api_key") return false;
  if (isLocalModelServerProvider(profile.provider)) return false;
  return credentialCount === 0;
}
