"use client";

/**
 * Policy state: load the indexer's configuration snapshot, edit a draft of it,
 * and continuously
 * plan the difference.
 *
 * The plan is derived from (fetched chain state, current draft) on every edit,
 * so what a reviewer reads and what gets signed are the same object. There is
 * no separate edit log.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RolesModifier } from "zodiac-roles-sdk";
import { fromRolesMod, toSdkState, type SdkState } from "./policy-codec";
import { buildPlan, type Plan } from "./policy-plan";
import type { DraftPolicy } from "./policy";
import { revive } from "./serialize";

export type Scope = { chainId: number; rolesMod: string };

export function samePolicyScope(a: Scope | null, b: Scope | null): boolean {
  return Boolean(
    a &&
      b &&
      a.chainId === b.chainId &&
      a.rolesMod.toLowerCase() === b.rolesMod.toLowerCase(),
  );
}

export type LoadStatus = "idle" | "loading" | "loaded" | "error";

export type ChainFacts = {
  owner: string;
  avatar: string;
  /** The modifier's execution target, normally the Safe itself. */
  target: string;
};

export type BaselineCheck =
  | { fresh: true; baseHash: string }
  | {
      fresh: false;
      reason: "changed" | "indexer-pending";
      previousHash: string;
      currentHash: string;
    };

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) throw new Error(`Empty response (${response.status}).`);
  // BigInt-tagged values are revived so allowance amounts stay exact.
  return revive<T>(JSON.parse(text));
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await readJson<T & { error?: string }>(response);
  if (!response.ok || body.error) {
    throw new Error(body.error ?? `Request failed (${response.status}).`);
  }
  return body;
}

function assertModifierAddress(mod: RolesModifier, expected: string): void {
  if (
    !mod.address ||
    mod.address.toLowerCase() !== expected.toLowerCase()
  ) {
    throw new Error(
      `The policy source returned ${mod.address || "an unknown modifier"} instead of ${expected}.`,
    );
  }
}

/** Stable fingerprint of the chain state a draft was based on. */
export async function fingerprint(
  state: SdkState,
  facts?: ChainFacts,
): Promise<string> {
  const canonical = JSON.stringify({ state, facts }, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export type PolicyState = {
  status: LoadStatus;
  error: string | null;
  scope: Scope | null;
  facts: ChainFacts | null;
  /** Indexed policy snapshot used as the baseline for a diff. */
  current: SdkState | null;
  baseHash: string | null;
  draft: DraftPolicy | null;
  plan: Plan;
  dirty: boolean;
  load: (scope: Scope) => Promise<void>;
  reload: () => Promise<void>;
  setDraft: (update: (draft: DraftPolicy) => DraftPolicy) => void;
  discard: () => void;
  applyDraft: (policy: DraftPolicy) => void;
  /**
   * Re-fetches the indexed state immediately before submission. A changed
   * baseline is installed so React rebuilds the review plan, but never submitted
   * in the same click.
   */
  recheckBaseline: () => Promise<BaselineCheck>;
  /** Prevents another proposal until the indexer observes the submitted state. */
  markSubmitted: () => void;
};

const idlePlan: Plan = {
  calls: [],
  transactions: [],
  changes: [],
  issues: [],
  risk: "Low",
};

export function usePolicy(): PolicyState {
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope | null>(null);
  const [facts, setFacts] = useState<ChainFacts | null>(null);
  const [current, setCurrent] = useState<SdkState | null>(null);
  const [baseHash, setBaseHash] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftPolicy | null>(null);
  const [pristine, setPristine] = useState<string | null>(null);

  // Guards against a slow response for a scope the user has moved away from
  // overwriting the policy they are now looking at.
  const loadToken = useRef(0);
  const scopeRef = useRef<Scope | null>(null);
  const submittedBaseHash = useRef<string | null>(null);

  const load = useCallback(async (next: Scope) => {
    const token = ++loadToken.current;
    if (!samePolicyScope(scopeRef.current, next)) submittedBaseHash.current = null;
    scopeRef.current = next;
    setStatus("loading");
    setError(null);
    setScope(next);

    try {
      const { mod } = await request<{ mod: RolesModifier }>(
        `/api/rolesmod?chainId=${next.chainId}&address=${next.rolesMod}`,
      );
      if (token !== loadToken.current) return;
      assertModifierAddress(mod, next.rolesMod);

      const chainState: SdkState = { roles: mod.roles, allowances: mod.allowances };
      const imported = fromRolesMod(mod, next.chainId);
      const nextFacts = {
        owner: mod.owner,
        avatar: mod.avatar,
        target: mod.target,
      };
      const hash = await fingerprint(chainState, nextFacts);
      if (token !== loadToken.current) return;
      if (
        submittedBaseHash.current &&
        hash !== submittedBaseHash.current
      ) {
        submittedBaseHash.current = null;
      }

      setFacts(nextFacts);
      setCurrent(chainState);
      setBaseHash(hash);
      setDraft(imported);
      setPristine(JSON.stringify(imported));
      setStatus("loaded");
    } catch (caught) {
      if (token !== loadToken.current) return;
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "Could not load the policy.");
      setCurrent(null);
      setDraft(null);
    }
  }, []);

  const reload = useCallback(async () => {
    if (scope) await load(scope);
  }, [load, scope]);

  const update = useCallback((updater: (value: DraftPolicy) => DraftPolicy) => {
    setDraft((value) => (value ? updater(value) : value));
  }, []);

  const discard = useCallback(() => {
    if (!pristine) return;
    setDraft(JSON.parse(pristine) as DraftPolicy);
  }, [pristine]);

  const applyDraft = useCallback((policy: DraftPolicy) => {
    const active = scopeRef.current;
    if (
      !active ||
      policy.chainId !== active.chainId ||
      policy.rolesMod.toLowerCase() !== active.rolesMod.toLowerCase()
    ) {
      throw new Error(
        "This draft belongs to a different chain or Roles modifier and cannot be opened here.",
      );
    }
    setDraft(policy);
  }, []);

  const recheckBaseline = useCallback(async (): Promise<BaselineCheck> => {
    const active = scopeRef.current;
    if (!active || !current || !baseHash) {
      throw new Error("The indexed policy baseline is not loaded.");
    }

    // The nonce and no-store mode avoid browser/CDN reuse. This endpoint is
    // indexer-backed, so after a submission we additionally require the
    // fingerprint to advance before accepting another proposal.
    const { mod } = await request<{ mod: RolesModifier }>(
      `/api/rolesmod?chainId=${active.chainId}&address=${active.rolesMod}&fresh=${Date.now()}`,
      { cache: "no-store", headers: { "cache-control": "no-cache" } },
    );
    assertModifierAddress(mod, active.rolesMod);
    if (!samePolicyScope(scopeRef.current, active)) {
      throw new Error("The open modifier changed while its baseline was checked.");
    }

    const chainState: SdkState = {
      roles: mod.roles,
      allowances: mod.allowances,
    };
    const nextFacts = {
      owner: mod.owner,
      avatar: mod.avatar,
      target: mod.target,
    };
    const hash = await fingerprint(chainState, nextFacts);
    if (!samePolicyScope(scopeRef.current, active)) {
      throw new Error("The open modifier changed while its baseline was checked.");
    }

    if (submittedBaseHash.current === hash) {
      return {
        fresh: false,
        reason: "indexer-pending",
        previousHash: baseHash,
        currentHash: hash,
      };
    }
    if (hash !== baseHash) {
      const imported = fromRolesMod(mod, active.chainId);
      setFacts(nextFacts);
      setCurrent(chainState);
      setBaseHash(hash);
      setPristine(JSON.stringify(imported));
      setStatus("loaded");
      submittedBaseHash.current = null;
      return {
        fresh: false,
        reason: "changed",
        previousHash: baseHash,
        currentHash: hash,
      };
    }
    return { fresh: true, baseHash: hash };
  }, [baseHash, current]);

  const markSubmitted = useCallback(() => {
    submittedBaseHash.current = baseHash;
  }, [baseHash]);

  const plan = useMemo<Plan>(() => {
    if (!draft || !current || !scope) return idlePlan;
    const { state, issues } = toSdkState(draft);
    return buildPlan({
      rolesMod: scope.rolesMod,
      current,
      desired: state,
      issues,
    });
  }, [draft, current, scope]);

  const dirty = useMemo(
    () => Boolean(draft && pristine && JSON.stringify(draft) !== pristine),
    [draft, pristine],
  );

  return {
    status,
    error,
    scope,
    facts,
    current,
    baseHash,
    draft,
    plan,
    dirty,
    load,
    reload,
    setDraft: update,
    discard,
    applyDraft,
    recheckBaseline,
    markSubmitted,
  };
}

/** Roles modifiers attached to a Safe, for scope selection without typing an address. */
export function useDiscoveredMods(
  safeAddress: string | null,
  chainId: number | null,
): {
  mods: { address: string; chainId: number; owner: string; avatar: string }[];
  loading: boolean;
  error: string | null;
} {
  const [mods, setMods] = useState<
    { address: string; chainId: number; owner: string; avatar: string }[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!safeAddress || chainId === null) return;
    let cancelled = false;

    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const body = await request<{
          mods: { address: string; chainId: number; owner: string; avatar: string }[];
        }>(`/api/rolesmods?avatar=${safeAddress}&chainId=${chainId}`);
        if (!cancelled) setMods(body.mods);
      } catch (caught) {
        if (!cancelled) {
          setError(
            caught instanceof Error ? caught.message : "Could not list modifiers.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [safeAddress, chainId]);

  // Derived rather than cleared in the effect, so results for a previous Safe
  // can never be shown against a different one.
  const scoped = safeAddress && chainId !== null ? mods : [];
  return { mods: scoped, loading, error };
}
