import { useEffect, useState } from "react";
import { createUnwrapperReader, readUnwrapperStates, type UnwrapState } from "./unwrappers";

/** On-chain adapter status for the modifier being edited. */
export function useUnwrapperStates(chainId: number | null, rolesMod: string | null, refreshKey = 0): {
  states: Record<string, UnwrapState> | null;
  error: string | null;
} {
  const identity = chainId !== null && rolesMod ? `${chainId}:${rolesMod.toLowerCase()}:${refreshKey}` : null;
  const [result, setResult] = useState<{ identity: string | null; states: Record<string, UnwrapState> | null; error: string | null }>({ identity: null, states: null, error: null });

  useEffect(() => {
    if (!identity || chainId === null || !rolesMod) return;
    let cancelled = false;
    void (async () => {
      try {
        const states = await readUnwrapperStates(chainId, createUnwrapperReader(chainId, rolesMod));
        if (!cancelled) setResult({ identity, states, error: null });
      } catch (caught) {
        if (!cancelled) setResult({ identity, states: null, error: caught instanceof Error ? caught.message : "Could not read batching status." });
      }
    })();
    return () => { cancelled = true; };
  }, [identity, chainId, rolesMod]);

  return result.identity === identity ? { states: result.states, error: result.error } : { states: null, error: null };
}
