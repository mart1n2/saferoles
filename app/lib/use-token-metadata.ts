import { useQuery } from "@tanstack/react-query";
import { isAddress } from "viem";
import { readTokenMetadata } from "./token-metadata";

export function useTokenMetadata(chainId: number, address: string, enabled = true) {
  const checked = address.trim().toLowerCase();
  return useQuery({ queryKey: ["token-metadata", chainId, checked], queryFn: () => readTokenMetadata(chainId, checked), enabled: enabled && isAddress(checked), staleTime: 300_000, retry: false });
}
