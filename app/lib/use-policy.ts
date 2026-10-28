
/**
 * Policy state: load the indexer's configuration snapshot, edit a draft of it,
 * and continuously
 * plan the difference.
 *
 * The plan is derived from (fetched chain state, current draft) on every edit,
 * so what a reviewer reads and what gets signed are the same object. There is
 * no separate edit log.
 */
import { discoverOnChain, mergeMods, readUnindexedModifier } from "./onchain-mods";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RolesModifier } from "zodiac-roles-sdk";
import { fromRolesMod, isBlankPermission, lockDeployedRoleKeys, toSdkState, type SdkState } from "./policy-codec";
import { buildPlan, withUnwrappers, type Plan } from "./policy-plan";
import type { DraftPolicy } from "./policy";
import { browserRolesReader } from "./browser-data";
import {
  clearSavedForm,
  formKeys,
  isRecoveredPolicyChange,
  parsePolicyWorkingCopy,
  readSavedForm,
  writeSavedForm,
  type PolicyWorkingCopy,
} from "./form-drafts";

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
   * Unsaved edits restored from this browser. They are diffs against the
   * freshly indexed baseline, never a stored chain state.
   */
  recovered: { savedAt: number; baseHash: string | null } | null;
  /** Hides the recovery notice while keeping the restored edits. */
  dismissRecovered: () => void;
  /** The modifier exists on chain but the indexer has not seen it: the baseline is empty and unverified. */
  unindexed: boolean;
  /** When the current unsaved edits were last written locally. */
  autosavedAt: number | null;
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
  const [recovered, setRecovered] = useState<{
    savedAt: number;
    baseHash: string | null;
  } | null>(null);
  const [unindexed, setUnindexed] = useState(false);
  const [autosavedAt, setAutosavedAt] = useState<number | null>(null);
  // A submission clears the working copy; an in-flight debounce must not write
  // the submitted diff back, so the first manual edit re-enables autosave.
  const skipAutosave = useRef(false);

  // Guards against a slow response for a scope the user has moved away from
  // overwriting the policy they are now looking at.
  const loadToken = useRef(0);
  const scopeRef = useRef<Scope | null>(null);
  const submittedBaseHash = useRef<string | null>(null);

  const load = useCallback(async (next: Scope) => {
    const token = ++loadToken.current;
    if (!samePolicyScope(scopeRef.current, next)) submittedBaseHash.current = null;
    scopeRef.current = next;
    skipAutosave.current = false;
    setRecovered(null);
    setAutosavedAt(null);
    setStatus("loading");
    setError(null);
    setScope(next);

    try {
      const indexedMod = await browserRolesReader.read({chainId:next.chainId,address:next.rolesMod});
      // A modifier deployed moments ago is on chain before the indexer sees it.
      const mod = indexedMod ?? await readUnindexedModifier(next.rolesMod, next.chainId).catch(() => null);
      if (!mod) throw new Error("No Roles modifier is indexed at this address.");
      setUnindexed(!indexedMod);
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

      // Unsaved edits are restored as a diff against the snapshot just read,
      // not as a stored policy. They were saved automatically while editing and
      // still go through review and the pre-submission baseline recheck.
      const workingKey = formKeys.policy(next.chainId, next.rolesMod);
      const saved = await readSavedForm<PolicyWorkingCopy>(workingKey, (value) =>
        parsePolicyWorkingCopy(value, next),
      );
      if (token !== loadToken.current) return;
      const restored =
        saved && isRecoveredPolicyChange(saved.data, imported)
          ? lockDeployedRoleKeys(saved.data.policy, chainState)
          : null;
      if (saved && !restored) void clearSavedForm(workingKey);

      setFacts(nextFacts);
      setCurrent(chainState);
      setBaseHash(hash);
      setDraft(restored ?? imported);
      setPristine(JSON.stringify(imported));
      setRecovered(
        restored && saved
          ? { savedAt: saved.savedAt, baseHash: saved.data.baseHash }
          : null,
      );
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
    skipAutosave.current = false;
    setDraft((value) => (value ? updater(value) : value));
  }, []);

  const discard = useCallback(() => {
    if (!pristine) return;
    skipAutosave.current = false;
    setDraft(JSON.parse(pristine) as DraftPolicy);
    setRecovered(null);
    setAutosavedAt(null);
  }, [pristine]);

  const dismissRecovered = useCallback(() => setRecovered(null), []);

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
    skipAutosave.current = false;
    setRecovered(null);
    setDraft(current ? lockDeployedRoleKeys(policy, current) : policy);
  }, [current]);

  const recheckBaseline = useCallback(async (): Promise<BaselineCheck> => {
    const active = scopeRef.current;
    if (!active || !current || !baseHash) {
      throw new Error("The indexed policy baseline is not loaded.");
    }

    // No-store mode avoids browser/CDN reuse. This source is
    // indexer-backed, so after a submission we additionally require the
    // fingerprint to advance before accepting another proposal.
    const mod = await browserRolesReader.read({chainId:active.chainId,address:active.rolesMod},{cache:"no-store"});
    if (!mod) throw new Error("The Roles modifier is not indexed yet.");
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
      setDraft(previous => previous ? lockDeployedRoleKeys(previous, chainState) : previous);
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
    skipAutosave.current = true;
    setRecovered(null);
    setAutosavedAt(null);
    const active = scopeRef.current;
    if (active) void clearSavedForm(formKeys.policy(active.chainId, active.rolesMod));
  }, [baseHash]);

  const dirty = useMemo(
    () => Boolean(draft && pristine && JSON.stringify(draft) !== pristine),
    [draft, pristine],
  );

  const workingKey = scope ? formKeys.policy(scope.chainId, scope.rolesMod) : null;

  // Debounced autosave of the current diff. Only changes are stored; the
  // unmodified baseline never becomes a "recovered" edit.
  useEffect(() => {
    if (!workingKey || !draft || !dirty || status !== "loaded" || skipAutosave.current) return;
    // Blank, never-started permissions are not worth recovering.
    const savable: DraftPolicy = { ...draft, roles: draft.roles.map((role) => ({ ...role, permissions: role.permissions.filter((permission) => !isBlankPermission(permission)) })) };
    if (JSON.stringify(savable) === pristine) {
      void clearSavedForm(workingKey);
      return;
    }
    const value: PolicyWorkingCopy = { policy: savable, baseHash };
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void writeSavedForm(workingKey, value)
        .then((savedAt) => {
          if (!cancelled) setAutosavedAt(savedAt);
        })
        .catch(() => {
          if (!cancelled) setAutosavedAt(null);
        });
    }, 500);
    // A reload or tab close can happen inside the debounce window; try to keep
    // the last keystrokes instead of silently losing them.
    const flush = () => {
      void writeSavedForm(workingKey, value).catch(() => {});
    };
    window.addEventListener("pagehide", flush);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener("pagehide", flush);
    };
  }, [workingKey, draft, dirty, status, baseHash, pristine]);

  // Discarding or reverting the edits leaves nothing to recover.
  useEffect(() => {
    if (!workingKey || status !== "loaded" || dirty) return;
    void clearSavedForm(workingKey);
  }, [workingKey, status, dirty]);

  const plan = useMemo<Plan>(() => {
    if (!draft || !current || !scope) return idlePlan;
    const { state, issues } = toSdkState(draft);
    return withUnwrappers(
      buildPlan({
        rolesMod: scope.rolesMod,
        current,
        desired: state,
        issues,
      }),
      scope.rolesMod,
      scope.chainId,
      draft.unwrappers,
    );
  }, [draft, current, scope]);

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
    recovered,
    dismissRecovered,
    unindexed,
    autosavedAt: dirty ? autosavedAt : null,
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
  type DiscoveredMod = { address: string; chainId: number; owner: string; avatar: string };
  const identity = safeAddress && chainId !== null ? `${chainId}:${safeAddress.toLowerCase()}` : null;
  const [result, setResult] = useState<{ identity: string | null; mods: DiscoveredMod[]; loading: boolean; error: string | null }>({ identity: null, mods: [], loading: false, error: null });

  useEffect(() => {
    if (!safeAddress || chainId === null) return;
    let cancelled = false;

    void (async () => {
      setResult({ identity, mods: [], loading: true, error: null });
      try {
        // The indexer can lag a fresh deployment, so also read the Safe's own modules.
        const [indexed, onChain] = await Promise.allSettled([browserRolesReader.discover(safeAddress), discoverOnChain(safeAddress, chainId)]);
        if (indexed.status === "rejected" && onChain.status === "rejected") throw indexed.reason;
        const mods = mergeMods(indexed.status === "fulfilled" ? indexed.value : [], onChain.status === "fulfilled" ? onChain.value : []);
        mods.sort((a,b)=>Number(b.chainId===chainId)-Number(a.chainId===chainId) || a.chainId-b.chainId);
        if (!cancelled) setResult({identity,mods,loading:false,error:null});
      } catch (caught) {
        if (!cancelled) {
          setResult({ identity, mods: [], loading: false, error: caught instanceof Error ? caught.message : "Could not list modifiers." });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [safeAddress, chainId, identity]);

  // Never show a previous Safe's response while a new lookup starts.
  return result.identity === identity
    ? result
    : { mods: [], loading: identity !== null, error: null };
}
