"use client";

/**
 * Client access to saved drafts.
 *
 * A draft records the policy someone is working on plus a fingerprint of the
 * chain state it was based on, so reopening it can warn when the modifier has
 * moved on underneath — the case where a diff would otherwise be computed
 * against a baseline that no longer exists.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DraftPolicy } from "./policy";
import { revive, stringify } from "./serialize";

export type DraftSummary = {
  id: string;
  name: string;
  chainId: number;
  rolesMod: string;
  safeAddress: string;
  baseStateHash: string | null;
  createdBy: string;
  version: number;
  createdAt: number;
  updatedAt: number;
};

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  const body = text ? revive<T & { error?: string }>(JSON.parse(text)) : ({} as T & { error?: string });
  if (!response.ok || body.error) {
    throw new Error(body.error ?? `Request failed (${response.status}).`);
  }
  return body;
}

export type DraftsState = {
  drafts: DraftSummary[];
  /** Null when no database is bound; drafts then simply are not offered. */
  available: boolean;
  busy: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  save: (input: {
    name: string;
    policy: DraftPolicy;
    safeAddress: string;
    baseStateHash: string | null;
    draftId?: string | null;
    draftVersion?: number | null;
  }) => Promise<{ id: string; version: number }>;
  open: (
    summary: DraftSummary,
  ) => Promise<{
    policy: DraftPolicy;
    baseStateHash: string | null;
    version: number;
  }>;
  remove: (summary: DraftSummary) => Promise<void>;
};

export function useDrafts(
  chainId: number | null,
  rolesMod: string | null,
): DraftsState {
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshGeneration = useRef(0);
  const refreshAbort = useRef<AbortController | null>(null);
  const scopeKey =
    chainId === null || !rolesMod
      ? null
      : `${chainId}:${rolesMod.toLowerCase()}`;
  const activeScopeKey = useRef<string | null>(scopeKey);
  useLayoutEffect(() => {
    activeScopeKey.current = scopeKey;
  }, [scopeKey]);

  const refresh = useCallback(async () => {
    // A save started in scope A may finish after the UI has moved to scope B
    // and invoke the refresh closure it captured. Reject it before it can bump
    // the shared generation or abort B's in-flight request.
    if (activeScopeKey.current !== scopeKey) return;
    const generation = ++refreshGeneration.current;
    refreshAbort.current?.abort();
    if (chainId === null || !rolesMod) {
      setDrafts([]);
      setBusy(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    refreshAbort.current = controller;
    setBusy(true);
    setError(null);
    try {
      const body = await call<{ drafts: DraftSummary[] }>(
        `/api/drafts?chainId=${chainId}&rolesMod=${rolesMod}`,
        { signal: controller.signal },
      );
      if (
        generation !== refreshGeneration.current ||
        activeScopeKey.current !== scopeKey
      ) {
        return;
      }
      setDrafts(
        body.drafts.filter(
          (draft) =>
            draft.chainId === chainId &&
            draft.rolesMod.toLowerCase() === rolesMod.toLowerCase(),
        ),
      );
      setAvailable(true);
    } catch (caught) {
      if (
        generation !== refreshGeneration.current ||
        activeScopeKey.current !== scopeKey ||
        (caught instanceof DOMException && caught.name === "AbortError")
      ) {
        return;
      }
      const message = caught instanceof Error ? caught.message : "Could not list drafts.";
      // A missing binding is a capability gap, not an error to shout about.
      if (/no database is bound|authentication is required/i.test(message)) {
        setAvailable(false);
        setDrafts([]);
      } else setError(message);
    } finally {
      if (
        generation === refreshGeneration.current &&
        activeScopeKey.current === scopeKey
      ) {
        setBusy(false);
      }
    }
  }, [chainId, rolesMod, scopeKey]);

  useEffect(() => {
    // Deferred out of the effect body: the drafts list is supplementary, so it
    // should not make the first paint a cascading re-render.
    const timer = setTimeout(() => void refresh(), 0);
    return () => {
      clearTimeout(timer);
      refreshAbort.current?.abort();
      refreshGeneration.current += 1;
    };
  }, [refresh]);

  const save = useCallback<DraftsState["save"]>(
    async (input) => {
      if (chainId === null || !rolesMod) throw new Error("No modifier is open.");
      if (
        input.policy.chainId !== chainId ||
        input.policy.rolesMod.toLowerCase() !== rolesMod.toLowerCase()
      ) {
        throw new Error(
          "The draft policy does not match the open chain and Roles modifier.",
        );
      }
      setBusy(true);
      try {
        if (input.draftId) {
          if (!input.draftVersion) {
            throw new Error(
              "The open draft has no version. Reopen it before saving.",
            );
          }
          const body = await call<{ draft: DraftSummary }>(
            `/api/drafts/${input.draftId}`,
            {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: stringify({
                chainId,
                rolesMod,
                version: input.draftVersion,
                policy: input.policy,
                name: input.name,
                baseStateHash: input.baseStateHash,
              }),
            },
          );
          if (activeScopeKey.current !== scopeKey) {
            throw new Error(
              "The open modifier changed while the draft was being saved.",
            );
          }
          await refresh();
          return { id: body.draft.id, version: body.draft.version };
        }
        const body = await call<{ draft: DraftSummary }>("/api/drafts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: stringify({
            name: input.name,
            chainId,
            rolesMod,
            safeAddress: input.safeAddress,
            policy: input.policy,
            baseStateHash: input.baseStateHash,
          }),
        });
        if (activeScopeKey.current !== scopeKey) {
          throw new Error(
            "The open modifier changed while the draft was being saved.",
          );
        }
        await refresh();
        return { id: body.draft.id, version: body.draft.version };
      } finally {
        if (activeScopeKey.current === scopeKey) setBusy(false);
      }
    },
    [chainId, refresh, rolesMod, scopeKey],
  );

  const open = useCallback<DraftsState["open"]>(
    async (summary) => {
      if (chainId === null || !rolesMod) throw new Error("No modifier is open.");
      const expectedChainId = chainId;
      const expectedRolesMod = rolesMod.toLowerCase();
      if (
        summary.chainId !== expectedChainId ||
        summary.rolesMod.toLowerCase() !== expectedRolesMod
      ) {
        throw new Error(
          "This draft summary belongs to a different chain or Roles modifier.",
        );
      }
      const body = await call<{
        draft: {
          chainId?: number;
          rolesMod?: string;
          policy: DraftPolicy;
          baseStateHash: string | null;
          version: number;
        };
      }>(
        `/api/drafts/${summary.id}?chainId=${chainId}&rolesMod=${encodeURIComponent(rolesMod)}`,
      );
      if (activeScopeKey.current !== scopeKey) {
        throw new Error(
          "The open modifier changed while the draft was being opened.",
        );
      }
      const embedded = body.draft.policy;
      const storedChainId = body.draft.chainId ?? embedded.chainId;
      const storedRolesMod = body.draft.rolesMod ?? embedded.rolesMod;
      if (
        storedChainId !== expectedChainId ||
        storedRolesMod.toLowerCase() !== expectedRolesMod ||
        embedded.chainId !== expectedChainId ||
        embedded.rolesMod.toLowerCase() !== expectedRolesMod
      ) {
        throw new Error(
          "This draft belongs to a different chain or Roles modifier and was not opened.",
        );
      }
      return {
        policy: embedded,
        baseStateHash: body.draft.baseStateHash,
        version: body.draft.version,
      };
    },
    [chainId, rolesMod, scopeKey],
  );

  const remove = useCallback<DraftsState["remove"]>(
    async (summary) => {
      if (chainId === null || !rolesMod) throw new Error("No modifier is open.");
      await call(
        `/api/drafts/${summary.id}?chainId=${chainId}&rolesMod=${encodeURIComponent(rolesMod)}&version=${summary.version}`,
        { method: "DELETE" },
      );
      if (activeScopeKey.current !== scopeKey) return;
      await refresh();
    },
    [chainId, refresh, rolesMod, scopeKey],
  );

  return useMemo(
    () => ({ drafts, available, busy, error, refresh, save, open, remove }),
    [available, busy, drafts, error, open, refresh, remove, save],
  );
}
