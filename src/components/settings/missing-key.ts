/**
 * "The model is here, its key is not" — which channel failed, and how sure we
 * are allowed to sound about it.
 *
 * Per [D-018](../../../docs/roadmap/mobile-ios.md#d-018--a-missing-credential-names-the-channel-that-failed-instead-of-shrugging),
 * two independent channels carry a model to a second device. Its name, provider
 * and endpoint ride the iCloud Documents container along with the library; its
 * key rides a synchronizable Keychain item. Nothing reports the Keychain
 * switch — a write with it off still returns success, and Apple puts no bound
 * on arrival time once it is on — so the cause is genuinely undetectable.
 *
 * What *is* observable is the other channel. A named peer in `sync_status` is
 * direct evidence that the document channel delivers from that device. When a
 * configuration arrived and its credential did not, the two channels differ by
 * exactly one variable, and naming that variable points at a switch the reader
 * can go and flip. The conclusion stays an inference in the copy — "probably",
 * never "it is off" — and the pane shows the observation it reasoned from.
 *
 * The states are kept here, apart from the component, because the interesting
 * part is the decision and not the markup.
 */

/** As much of `sync_status`'s peer as this decision reads. */
export interface MissingKeyPeer {
  name: string;
  last_seen: number;
}

export type MissingKeyState =
  /** Nothing to say: there is a key, or this profile does not use keys. */
  | { kind: "none" }
  /** Too early to blame anything. A key entered on a Mac a moment ago is
   *  probably still in flight, and saying otherwise would be wrong most of the
   *  time it is said. */
  | { kind: "waiting" }
  /** One channel through, the other not, for longer than that. */
  | { kind: "inferred"; peer: string }
  /** No second device, so no control channel and nothing to infer from. */
  | { kind: "alone" };

/**
 * How long the pane stays on "give it a moment" before it will name a channel.
 *
 * A minute is the cost of the false positive D-018 accepts: the switch is on
 * and this one item is merely late. Escalating on a threshold rather than
 * hedging harder keeps the eventual sentence worth reading.
 */
export const KEYCHAIN_GRACE_MS = 60_000;

export interface MissingKeyInput {
  /** This profile authenticates with API keys and has none on this device. */
  missing: boolean;
  /**
   * This platform is on the iCloud pair — the one place both channels exist, so
   * the one place comparing them means anything. Windows keeps its credentials
   * local and never had a second channel to lose.
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
  if (profile.provider === "ollama") return false;
  return credentialCount === 0;
}
