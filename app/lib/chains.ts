/**
 * Chain support, taken from the Roles deployments package rather than a local
 * list, so the app never offers a chain whose policy it cannot read.
 */
import { chains } from "zodiac-roles-sdk";

export type SupportedChainId = keyof typeof chains;

export const supportedChainIds = Object.keys(chains).map(Number) as SupportedChainId[];

export function isSupportedChain(chainId: number): chainId is SupportedChainId {
  return chainId in chains;
}

export function chainName(chainId: number): string {
  return isSupportedChain(chainId) ? chains[chainId].name : `chain ${chainId}`;
}

/** Short prefix Safe uses in its own URLs, e.g. `eth:0x…`. */
export function chainPrefix(chainId: number): string | null {
  return isSupportedChain(chainId) ? chains[chainId].prefix : null;
}

/**
 * Deep link to a queued Safe transaction.
 *
 * Returns null on an unsupported chain rather than guessing a prefix — a link
 * built with the wrong prefix points at a different Safe.
 */
export function safeTransactionUrl(
  chainId: number,
  safeAddress: string,
  safeTxHash: string,
): string | null {
  const prefix = chainPrefix(chainId);
  if (!prefix) return null;
  return `https://app.safe.global/transactions/tx?safe=${prefix}:${safeAddress}&id=multisig_${safeAddress}_${safeTxHash}`;
}

/**
 * Networks the SDK lists but where the pinned official Roles mastercopy has no code
 * (checked on three RPCs for Polygon zkEVM, whose ModuleProxyFactory exists). Existing
 * configurations can still be looked up; new ones cannot be set up there.
 */
const NO_OFFICIAL_ROLES: ReadonlySet<number> = new Set([1101]);

export function hasOfficialRoles(chainId: number): boolean {
  return !NO_OFFICIAL_ROLES.has(chainId);
}

/** Network name for a picker, flagged when setup is impossible there. */
export function chainOptionLabel(chainId: number): string {
  return hasOfficialRoles(chainId) ? chainName(chainId) : `${chainName(chainId)} (no official Roles contract)`;
}

/**
 * The official Zodiac app as a Safe App, preselecting the network. Initialising a
 * Roles modifier there is the recommended route; Safe lets the user pick the Safe.
 */
export function zodiacAppUrl(chainId: number): string | null {
  const prefix = chainPrefix(chainId);
  if (!prefix) return null;
  return `https://app.safe.global/share/safe-app?appUrl=${encodeURIComponent("https://zodiac.gnosisguild.org/")}&chain=${prefix}`;
}
