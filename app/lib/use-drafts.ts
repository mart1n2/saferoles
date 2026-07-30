"use client";

/**
 * Client access to saved drafts.
 *
 * A draft records the policy someone is working on plus a fingerprint of the
 * chain state it was based on, so reopening it can warn when the modifier has
 * moved on underneath — the case where a diff would otherwise be computed
 * against a baseline that no longer exists.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DraftPolicy } from "./policy";
import { revive } from "./serialize";

export type DraftSummary = {
  id: string;
  name: string;
  chainId: number;
  rolesMod: string;
  baseStateHash: string | null;
  createdBy: string | null;
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
    author: string | null;
    draftId?: string | null;
  }) => Promise<string>;
  open: (draftId: string) => Promise<{ policy: DraftPolicy; baseStateHash: string | null }>;
  remove: (draftId: string) => Promise<void>;
};

export function useDrafts(
  chainId: number | null,
  rolesMod: string | null,
): DraftsState {
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (chainId === null || !rolesMod) return;
    setBusy(true);
    setError(null);
    try {
      const body = await call<{ drafts: DraftSummary[] }>(
        `/api/drafts?chainId=${chainId}&rolesMod=${rolesMod}`,
      );
      setDrafts(body.drafts);
      setAvailable(true);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not list drafts.";
      // A missing binding is a capability gap, not an error to shout about.
      if (/no database is bound/i.test(message)) setAvailable(false);
      else setError(message);
    } finally {
      setBusy(false);
    }
  }, [chainId, rolesMod]);

  useEffect(() => {
    // Deferred out of the effect body: the drafts list is supplementary, so it
    // should not make the first paint a cascading re-render.
    const timer = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(timer);
  }, [refresh]);

  const save = useCallback<DraftsState["save"]>(
    async (input) => {
      if (chainId === null || !rolesMod) throw new Error("No modifier is open.");
      setBusy(true);
      try {
        if (input.draftId) {
          await call(`/api/drafts/${input.draftId}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              policy: input.policy,
              name: input.name,
              author: input.author,
              baseStateHash: input.baseStateHash,
            }),
          });
          await refresh();
          return input.draftId;
        }
        const body = await call<{ draft: { id: string } }>("/api/drafts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: input.name,
            chainId,
            rolesMod,
            safeAddress: input.safeAddress,
            policy: input.policy,
            baseStateHash: input.baseStateHash,
            createdBy: input.author,
          }),
        });
        await refresh();
        return body.draft.id;
      } finally {
        setBusy(false);
      }
    },
    [chainId, refresh, rolesMod],
  );

  const open = useCallback<DraftsState["open"]>(async (draftId) => {
    const body = await call<{
      draft: { policy: DraftPolicy; baseStateHash: string | null };
    }>(`/api/drafts/${draftId}`);
    return { policy: body.draft.policy, baseStateHash: body.draft.baseStateHash };
  }, []);

  const remove = useCallback<DraftsState["remove"]>(
    async (draftId) => {
      await call(`/api/drafts/${draftId}`, { method: "DELETE" });
      await refresh();
    },
    [refresh],
  );

  return useMemo(
    () => ({ drafts, available, busy, error, refresh, save, open, remove }),
    [available, busy, drafts, error, open, refresh, remove, save],
  );
}
