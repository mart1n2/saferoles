import { createPublicClient, getAddress, http, parseAbi } from "viem";
import { walletChains } from "./wallet-chains";

export type TokenMetadata = { decimals: number; symbol: string; hasSymbol: boolean };
const metadataAbi = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);

/** Display metadata only; never used to alter a policy or its encoded values. */
export async function readTokenMetadata(chainId: number, address: string): Promise<TokenMetadata | null> {
  const chain = walletChains.find((entry) => entry.id === chainId);
  if (!chain) return null;
  const client = createPublicClient({ chain, transport: http(undefined, { timeout: 6000, retryCount: 0 }) });
  const checked = getAddress(address);
  const [decimals, symbol] = await Promise.allSettled([
    client.readContract({ address: checked, abi: metadataAbi, functionName: "decimals" }),
    client.readContract({ address: checked, abi: metadataAbi, functionName: "symbol" }),
  ]);
  if (decimals.status !== "fulfilled" || decimals.value > 36) return null;
  const label = symbol.status === "fulfilled" ? symbol.value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 32) : "";
  return { decimals: decimals.value, symbol: label || "tokens", hasSymbol: Boolean(label) };
}
