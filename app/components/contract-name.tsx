import { shortHex } from "../lib/abi";
import { useContractName } from "../lib/use-contract-name";

/** The best known name for a contract, otherwise the short address. */
export function ContractName({ chainId, address, label }: { chainId: number; address: string; label?: string }) {
  const { name } = useContractName(chainId, address, label);
  return <>{name || shortHex(address) || "New target"}</>;
}
