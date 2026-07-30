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
