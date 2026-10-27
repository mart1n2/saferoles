import { useSyncExternalStore } from "react";
import { getApiKey,subscribeApiKeys,apiKeysRevision,serverApiKeysRevision } from "../lib/api-keys";
import { readSafeTransactionStatus } from "../lib/safe-status-reader";
import { useQuery } from "@tanstack/react-query";
import type { SafeContext } from "../lib/use-safe";
import type { SafeTransactionStatus } from "../lib/safe-transaction-status";

const labels: Record<SafeTransactionStatus["state"],string> = {
  "awaiting-confirmations":"Awaiting signatures", "awaiting-execution":"Ready for execution",
  success:"Executed successfully", failed:"Execution failed", cancelled:"Cancelled", unknown:"Status unknown",
};
export function SafeTransactionStatusView({chainId,safeAddress,safeTxHash,safe,autoSync=true}:{
  chainId:number;safeAddress:string;safeTxHash:string;safe:SafeContext;autoSync?:boolean;
}) {
  const revision=useSyncExternalStore(subscribeApiKeys,apiKeysRevision,serverApiKeysRevision);
  const host = safe.mode === "safe-app" && safe.info?.chainId === chainId && safe.info.safeAddress.toLowerCase() === safeAddress.toLowerCase();
  const query = useQuery<SafeTransactionStatus, Error>({
    queryKey:["safe-transaction-status",chainId,safeAddress.toLowerCase(),safeTxHash,host?"host":"service",revision],
    enabled:autoSync && safe.mode !== "detecting", retry:false, staleTime:30_000,
    refetchOnWindowFocus:true,
    refetchInterval:state=> autoSync && !state.state.error && state.state.data && ["awaiting-confirmations","awaiting-execution","unknown"].includes(state.state.data.state) ? 60_000 : false,
    queryFn:async({signal}):Promise<SafeTransactionStatus>=>{
      if(host)return safe.transactionStatus(safeTxHash,chainId,safeAddress);
      signal.throwIfAborted();
      const key=getApiKey("safe");
      if(!key)throw new Error("Unlock your Safe API key in API keys, or view this transaction in Safe.");
      return readSafeTransactionStatus({chainId,safeAddress,safeTxHash},key);

    },
  });
  const status=query.data;
  return <div className="safe-transaction-status" aria-live="polite">
    <span>{query.error ? "Status sync unavailable" : status ? labels[status.state] : query.isFetching ? "Synchronizing Safe status…" : "Status not synchronized"}
      {status && !query.error && status.confirmations !== null && status.required !== null ? ` · ${status.confirmations}/${status.required} signatures` : ""}</span>
    {status && <small>Last observed {new Date(status.observedAt).toLocaleTimeString()} via {status.source === "safe-host" ? "Safe host" : "Safe Transaction Service"}{query.error ? " (stale)" : ""}</small>}
    {status?.transactionHash && <code title="Execution transaction hash">{status.transactionHash}</code>}
    {query.error && <small>{query.error.message}</small>}
    <button className="button ghost" disabled={query.isFetching} onClick={()=>void query.refetch()}>{query.isFetching ? "Syncing…" : "Refresh status"}</button>
  </div>;
}
