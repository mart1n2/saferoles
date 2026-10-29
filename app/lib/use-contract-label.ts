import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAddress } from "ethers";
import { contractLabelKey, readContractLabel, saveContractLabel, localContractsKey } from "./contract-labels";

export function useContractLabel(chainId: number, address: string) {
  const checked = address.trim();
  const client = useQueryClient();
  const label = useQuery({ queryKey: contractLabelKey(chainId, checked), queryFn: () => readContractLabel(chainId, checked), enabled: isAddress(checked.toLowerCase()), staleTime: Infinity });
  const save = useMutation({
    mutationFn: ({ chain, target, value }: { chain: number; target: string; value: string }) => saveContractLabel(chain, target, value),
    onSuccess: (_, { chain }) => { void client.invalidateQueries({ queryKey: localContractsKey(chain) }); },
    onMutate: ({ chain, target, value }) => {
      const queryKey = contractLabelKey(chain, target);
      void client.cancelQueries({ queryKey });
      client.setQueryData(queryKey, value);
    },
  });
  const currentSave = save.variables?.chain === chainId && save.variables.target.toLowerCase() === checked.toLowerCase();
  return {
    value: label.data,
    saving: currentSave && save.isPending,
    error: label.isError || (currentSave && save.isError) ? "Could not save this label locally. Check browser storage permissions." : null,
    save: (value: string, target = checked) => { if (isAddress(target.toLowerCase())) save.mutate({ chain: chainId, target, value }); },
  };
}
