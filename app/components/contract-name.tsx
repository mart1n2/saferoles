import { useAbi } from "../lib/use-abi";
import { shortHex } from "../lib/abi";
import { useContractLabel } from "../lib/use-contract-label";
import { useTokenMetadata } from "../lib/use-token-metadata";

/** The verified contract name when one is known, otherwise the short address. */
export function ContractName({ chainId, address, label }: { chainId: number; address: string; label?: string }) {
  const abi = useAbi(chainId, address);
  const saved = useContractLabel(chainId, address);
  const token = useTokenMetadata(chainId, address);
  const custom = saved.value ?? label;
  const name = custom?.trim() || (token.data?.hasSymbol ? token.data.symbol : null) || abi.abi?.name;
  return <>{name || shortHex(address) || "New target"}</>;
}
