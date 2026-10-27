import { chainPrefix } from "./chains";
import { parseServiceTransaction, validateSafeTransactionScope } from "./safe-transaction-status";

export async function readSafeTransactionStatus(scope: {chainId:number;safeAddress:string;safeTxHash:string}, apiKey: string, fetcher: typeof fetch = fetch) {
  validateSafeTransactionScope(scope);
  const prefix = chainPrefix(scope.chainId);
  if (!prefix) throw new Error("Unsupported network.");
  const response = await fetcher(`https://api.safe.global/tx-service/${encodeURIComponent(prefix)}/api/v2/multisig-transactions/${scope.safeTxHash}/`, {
    headers:{Authorization:`Bearer ${apiKey}`,Accept:"application/json"},
    cache:"no-store",signal:AbortSignal.timeout(10_000),redirect:"error",referrerPolicy:"no-referrer",
  });
  if (response.status === 404) throw new Error("Safe has not indexed this transaction, or this network is unavailable. This does not mean it failed or was cancelled.");
  if (!response.ok) throw new Error(`Safe status service unavailable (${response.status}).`);
  return parseServiceTransaction(await response.json(),scope);
}
