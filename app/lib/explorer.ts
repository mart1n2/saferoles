import { isAddress } from "ethers";
import { walletChains } from "./wallet-chains";

/** Block explorer page for an address on a supported chain, or null when none is known. */
export function addressExplorerUrl(chainId: number | null, address: string): string | null {
  if (chainId === null) return null;
  const trimmed = address.trim();
  if (!isAddress(trimmed.toLowerCase())) return null;
  const base = walletChains.find((chain) => chain.id === chainId)?.blockExplorers?.default.url;
  if (!base || !/^https:\/\//.test(base)) return null;
  return `${base.replace(/\/$/, "")}/address/${trimmed}`;
}

/** Name of the chain's explorer for button labels, e.g. "Etherscan". */
export function explorerName(chainId: number | null): string {
  return (chainId !== null && walletChains.find((chain) => chain.id === chainId)?.blockExplorers?.default.name) || "explorer";
}
