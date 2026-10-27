import { useAbi } from "../lib/use-abi";
import { shortHex } from "../lib/abi";

/** The verified contract name when one is known, otherwise the short address. */
export function ContractName({ chainId, address, label }: { chainId: number; address: string; label?: string }) {
  const abi = useAbi(chainId, address);
  const name = label || abi.abi?.name;
  return <>{name || shortHex(address) || "New target"}</>;
}
