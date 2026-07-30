"use client";

/**
 * Client access to contract ABIs and selector names.
 *
 * Two levels of resolution, because they cost different amounts:
 *  - {@link useAbi} fetches one contract's full ABI on demand. It yields
 *    parameter names and types, which is what makes the condition editor
 *    readable, so it runs for the permission being inspected.
 *  - {@link useSelectorNames} resolves many bare selectors in a single request,
 *    enough to label a whole imported policy without a lookup per target.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ResolvedAbi } from "./abi-source";

const abiCache = new Map<string, ResolvedAbi | null>();
const selectorCache = new Map<string, string[]>();

function cacheKey(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`;
}

export type AbiStatus = "idle" | "loading" | "found" | "unavailable" | "error";

export type AbiState = {
  status: AbiStatus;
  abi: ResolvedAbi | null;
  /** Why no ABI is available, phrased for display. */
  reason: string | null;
  /** Stores a hand-supplied ABI for this contract and adopts it immediately. */
  saveManual: (abi: string, name?: string) => Promise<void>;
  /** Drops the stored ABI so the next lookup consults the live sources again. */
  forget: () => Promise<void>;
};

const LOOKUP_DEBOUNCE_MS = 400;

export function useAbi(chainId: number | null, address: string): AbiState {
  const trimmed = address.trim();
  const enabled = chainId !== null && /^0x[0-9a-fA-F]{40}$/.test(trimmed);
  const key = enabled ? cacheKey(chainId, trimmed) : null;

  const [status, setStatus] = useState<AbiStatus>("idle");
  const [abi, setAbi] = useState<ResolvedAbi | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  // Bumped by `forget` so the lookup effect re-runs. Without it, clearing the
  // stored ABI left the panel blank until the address itself changed.
  const [attempt, setAttempt] = useState(0);
  const requestId = useRef(0);

  useEffect(() => {
    if (!key || chainId === null) {
      const timer = setTimeout(() => {
        setStatus("idle");
        setAbi(null);
        setReason(null);
      }, 0);
      return () => clearTimeout(timer);
    }

    if (abiCache.has(key)) {
      const cached = abiCache.get(key) ?? null;
      const timer = setTimeout(() => {
        setAbi(cached);
        setStatus(cached ? "found" : "unavailable");
        setReason(cached ? null : "No verified ABI is available for this contract.");
      }, 0);
      return () => clearTimeout(timer);
    }

    const token = ++requestId.current;
    const controller = new AbortController();
    // Debounced: the address arrives one keystroke at a time.
    const timer = setTimeout(() => {
      setStatus("loading");
      void (async () => {
        try {
          const response = await fetch(
            `/api/abi?chainId=${chainId}&address=${trimmed}`,
            { signal: controller.signal },
          );
          const body = (await response.json()) as {
            abi?: ResolvedAbi | null;
            reason?: string;
            error?: string;
          };
          if (token !== requestId.current) return;

          if (body.error) {
            setStatus("error");
            setReason(body.error);
            return;
          }
          const resolved = body.abi ?? null;
          abiCache.set(key, resolved);
          setAbi(resolved);
          setStatus(resolved ? "found" : "unavailable");
          setReason(resolved ? null : (body.reason ?? "No verified ABI is available."));
        } catch (error) {
          if (token !== requestId.current) return;
          if (error instanceof DOMException && error.name === "AbortError") return;
          setStatus("error");
          setReason("The ABI lookup failed.");
        }
      })();
    }, LOOKUP_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [chainId, key, trimmed, attempt]);

  const saveManual = useCallback(
    async (input: string, name?: string) => {
      if (chainId === null || !key) throw new Error("Enter the contract address first.");
      const response = await fetch("/api/abi", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chainId, address: trimmed, abi: input, name }),
      });
      const body = (await response.json()) as { abi?: ResolvedAbi; error?: string };
      if (!response.ok || body.error || !body.abi) {
        throw new Error(body.error ?? "That ABI could not be stored.");
      }
      abiCache.set(key, body.abi);
      // Newly named functions may resolve selectors elsewhere in the policy.
      for (const entry of body.abi.functions) {
        selectorCache.set(entry.selector.toLowerCase(), [entry.signature]);
      }
      setAbi(body.abi);
      setStatus("found");
      setReason(null);
    },
    [chainId, key, trimmed],
  );

  const forget = useCallback(async () => {
    if (chainId === null || !key) return;
    await fetch(`/api/abi?chainId=${chainId}&address=${trimmed}`, { method: "DELETE" });
    abiCache.delete(key);
    setAbi(null);
    setReason(null);
    // Re-resolve from the live sources rather than leaving the panel empty.
    setStatus("loading");
    setAttempt((value) => value + 1);
  }, [chainId, key, trimmed]);

  return useMemo(
    () => ({ status, abi, reason, saveManual, forget }),
    [abi, forget, reason, saveManual, status],
  );
}

/**
 * Resolves candidate signatures for bare selectors, in one request.
 *
 * Candidates are suggestions: a selector is a truncated hash, so several
 * signatures can share one. Callers must not adopt a name when more than one
 * candidate exists.
 */
export function useSelectorNames(selectors: readonly string[]): Record<string, string[]> {
  const wanted = useMemo(() => {
    const unique = new Set<string>();
    for (const selector of selectors) {
      const normalized = selector.toLowerCase();
      if (/^0x[0-9a-f]{8}$/.test(normalized) && !selectorCache.has(normalized)) {
        unique.add(normalized);
      }
    }
    return [...unique];
  }, [selectors]);

  /**
   * Names are held in state, not read straight out of the module cache.
   *
   * The cache still prevents refetching across mounts, but a component cannot
   * re-render because a plain Map mutated — reading through it made the result
   * depend on an invisible side effect, and names only ever appeared when some
   * unrelated edit happened to invalidate the memo.
   */
  const [resolved, setResolved] = useState<Record<string, string[]>>({});

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        // Anything a previous mount already resolved is available immediately.
        const cached = readSelectorCache(selectors);
        if (Object.keys(cached).length > 0) {
          setResolved((previous) => ({ ...previous, ...cached }));
        }
        if (wanted.length === 0) return;

        try {
          const response = await fetch(
            `/api/selectors?list=${wanted.slice(0, 200).join(",")}`,
            { signal: controller.signal },
          );
          const body = (await response.json()) as {
            signatures?: Record<string, string[]>;
          };
          for (const selector of wanted) {
            selectorCache.set(selector, body.signatures?.[selector] ?? []);
          }
          const fetched = readSelectorCache(wanted);
          if (Object.keys(fetched).length > 0) {
            setResolved((previous) => ({ ...previous, ...fetched }));
          }
        } catch {
          // Leave them unresolved; the raw selector is still shown.
        }
      })();
    }, 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [selectors, wanted]);

  return useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const selector of selectors) {
      const normalized = selector.toLowerCase();
      const names = resolved[normalized];
      if (names && names.length > 0) out[normalized] = names;
    }
    return out;
  }, [selectors, resolved]);
}

/** address (lowercase) → selector (lowercase) → readable signature. */
const namesCache = new Map<string, Record<string, string>>();

/**
 * Resolves readable, parameter-named signatures for many targets at once.
 *
 * Used by the permission list, where a types-only signature is exactly the thing
 * that makes a policy hard to review. Degrades silently: a target with no
 * published ABI keeps its canonical signature.
 */
export function useFunctionNames(
  chainId: number | null,
  addresses: readonly string[],
): Record<string, Record<string, string>> {
  const wanted = useMemo(() => {
    const unique = new Set<string>();
    for (const address of addresses) {
      const normalized = address.trim().toLowerCase();
      if (/^0x[0-9a-f]{40}$/.test(normalized) && !namesCache.has(`${chainId}:${normalized}`)) {
        unique.add(normalized);
      }
    }
    return [...unique];
  }, [addresses, chainId]);

  const [resolved, setResolved] = useState<Record<string, Record<string, string>>>({});

  useEffect(() => {
    if (chainId === null) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        const fromCache: Record<string, Record<string, string>> = {};
        for (const address of addresses) {
          const normalized = address.trim().toLowerCase();
          const hit = namesCache.get(`${chainId}:${normalized}`);
          if (hit) fromCache[normalized] = hit;
        }
        if (Object.keys(fromCache).length > 0) {
          setResolved((previous) => ({ ...previous, ...fromCache }));
        }
        if (wanted.length === 0) return;

        try {
          const response = await fetch("/api/abis", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chainId, addresses: wanted }),
            signal: controller.signal,
          });
          const body = (await response.json()) as {
            functions?: Record<string, Record<string, string>>;
          };
          const fetched = body.functions ?? {};
          for (const address of wanted) {
            // Cached either way, so an unresolvable target is not retried.
            namesCache.set(`${chainId}:${address}`, fetched[address] ?? {});
          }
          setResolved((previous) => ({ ...previous, ...fetched }));
        } catch {
          // Leave them as canonical signatures.
        }
      })();
    }, 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [addresses, chainId, wanted]);

  return resolved;
}

/** Pulls whatever is already known for `selectors` out of the shared cache. */
function readSelectorCache(selectors: readonly string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const selector of selectors) {
    const normalized = selector.toLowerCase();
    const names = selectorCache.get(normalized);
    if (names && names.length > 0) out[normalized] = names;
  }
  return out;
}
