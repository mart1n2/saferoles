import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { addLocalContract, contractLabelKey, listLocalContracts, localContractsKey, removeLocalContract } from "./contract-labels";

export function useLocalContracts(chainId: number) {
  const client = useQueryClient();
  const list = useQuery({ queryKey: localContractsKey(chainId), queryFn: () => listLocalContracts(chainId) });
  const change = useMutation({
    mutationFn: ({ chain, address, label, remove }: { chain: number; address: string; label?: string; remove: boolean }) => remove ? removeLocalContract(chain, address) : addLocalContract(chain, address, label),
    onSuccess: async (_, { chain, address }) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: localContractsKey(chain) }),
        client.invalidateQueries({ queryKey: contractLabelKey(chain, address) }),
      ]);
    },
  });
  return {
    contracts: list.data ?? [], loading: list.isPending, busy: change.isPending,
    error: list.error?.message ?? change.error?.message ?? null,
    add: (address: string, label?: string) => change.mutateAsync({ chain: chainId, address, label, remove: false }),
    remove: (address: string) => change.mutateAsync({ chain: chainId, address, remove: true }),
  };
}
