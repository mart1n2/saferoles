import { useAbi } from "./use-abi";
import { useContractLabel } from "./use-contract-label";
import { useTokenMetadata } from "./use-token-metadata";

export type ContractNameSource = "label" | "token" | "verified";

/**
 * The best known name for an address and where it came from: a label the user
 * saved, the token symbol the contract reports about itself, or the name from
 * verified source. `name` is null when nothing is known, so callers can say so
 * rather than leave a bare address that looks as trustworthy as a named one.
 */
export function useContractName(chainId: number, address: string, label?: string): { name: string | null; source: ContractNameSource | null } {
  const abi = useAbi(chainId, address);
  const saved = useContractLabel(chainId, address);
  const token = useTokenMetadata(chainId, address);
  const custom = (saved.value ?? label)?.trim();
  if (custom) return { name: custom, source: "label" };
  if (token.data?.hasSymbol) return { name: token.data.symbol, source: "token" };
  if (abi.abi?.name) return { name: abi.abi.name, source: "verified" };
  return { name: null, source: null };
}
