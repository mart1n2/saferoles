
/**
 * Policy state: load the modifier's configuration from the chain, edit a draft of it,
 * and continuously
 * plan the difference.
 *
 * The plan is derived from (fetched chain state, current draft) on every edit,
 * so what a reviewer reads and what gets signed are the same object. There is
 * no separate edit log.
 */
import { discoverOnChain, mergeMods, readMastercopy, type MastercopyStatus } from "./onchain-mods";
import { legacyEncoding, plannedCallIssues, standingWarnings } from "./policy-safety";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RolesModifier } from "zodiac-roles-sdk";
import { fromRolesMod, isBlankPermission, lockDeployedRoleKeys, toSdkState, type SdkState } from "./policy-codec";
import { buildPlan, withUnwrappers, type Plan } from "./policy-plan";
import type { DraftPolicy } from "./policy";
import { browserRolesReader } from "./browser-data";
import { policyChanged } from "./draft-changes";
import {
  clearSavedForm,
  formKeys,
  isRecoveredPolicyChange,
  parsePolicyWorkingCopy,
  readSavedForm,
  writeSavedForm,
  type PolicyWorkingCopy,
} from "./form-drafts";
import {
  blockedUntil,
  clearSubmissionMark,
  diffTransactions,
  readSubmissionMarks,
  rememberSubmission,
  sentCount,
  statusAfter,
  submissionVerdict,
  transactionDigests,
  type SubmissionMark,
} from "./submission-mark";
import type { SubmissionResult } from "./submission";

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
      reason: "changed";
      previousHash: string;
      currentHash: string;
    }
  | {
      fresh: false;
      /**
       * An earlier submission's calls are not on chain yet. "outcome-unknown":
       * it was interrupted, so they may or may not have gone out.
       */
      reason: "pending" | "outcome-unknown";
      previousHash: string;
      currentHash: string;
      /** When the block lifts even if the calls never appear on chain. */
      until: number;
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
  /** The draft as first loaded, for marking what has changed. */
  baseline: DraftPolicy | null;
  plan: Plan;
  dirty: boolean;
  load: (scope: Scope) => Promise<void>;
  reload: () => Promise<void>;
  setDraft: (update: (draft: DraftPolicy) => DraftPolicy) => void;
  discard: () => void;
  applyDraft: (policy: DraftPolicy) => void;
  /**
   * Unsaved edits restored from this browser. They are diffs against the
   * baseline just read from the chain, never a stored chain state.
   */
  recovered: { savedAt: number; baseHash: string | null } | null;
  /** Hides the recovery notice while keeping the restored edits. */
  dismissRecovered: () => void;
  /** When the current unsaved edits were last written locally. */
  autosavedAt: number | null;
  /**
   * Re-reads the chain state immediately before submission. A changed
   * baseline is installed so React rebuilds the review plan, but never submitted
   * in the same click.
   */
  recheckBaseline: () => Promise<BaselineCheck>;
  /** Which Roles release the open modifier runs; null until read (or when it could not be). */
  mastercopy: MastercopyStatus | null;
  /** Unsafe patterns in permissions already on chain. Reported, never blocking. */
  standingWarnings: string[];
  /** Permissions whose stored condition uses the pre-4.1.5 encoding of fixed-size arrays. */
  legacyPermissions: { roleId: string; permissionId: string; fixable: boolean }[];
  /**
   * Records a submission before its first signing prompt, so a page closed
   * partway still knows these transactions may have gone out.
   */
  beginSubmission: (transactions: readonly { to: string; value: string; data: string }[]) => Promise<void>;
  /** Records what went out. Until the chain shows it, resending those calls is blocked. */
  markSubmitted: (result: SubmissionResult) => void;
  /** Drops the record of a submission that sent nothing, or of interrupted ones the user has checked. */
  clearSubmission: (which: "current" | "interrupted") => Promise<void>;
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
  const [autosavedAt, setAutosavedAt] = useState<number | null>(null);
  const [mastercopy, setMastercopy] = useState<MastercopyStatus | null>(null);
  // A submission clears the working copy; an in-flight debounce must not write
  // the submitted diff back, so the first manual edit re-enables autosave.
  const skipAutosave = useRef(false);

  // Guards against a slow response for a scope the user has moved away from
  // overwriting the policy they are now looking at.
  const loadToken = useRef(0);
  const scopeRef = useRef<Scope | null>(null);
  // Submission records, mirrored in memory for browsers without storage. Keyed
  // by the same storage key, so they are scoped to their modifier.
  const submissions = useRef(new Map<string, { mark: SubmissionMark; persisted: boolean }>());
  const activeSubmission = useRef<{ scope: Scope; key: string } | null>(null);

  const forgetSubmission = useCallback(async (scope: Scope, id: string) => {
    submissions.current.delete(formKeys.submitted(scope.chainId, scope.rolesMod, id));
    await clearSubmissionMark(scope, id);
  }, []);

  /** Recorded submissions for `scope` from storage (any tab) and from this page. */
  const submissionMarks = useCallback(async (scope: Scope): Promise<SubmissionMark[]> => {
    const stored = new Map((await readSubmissionMarks(scope)).map((mark) => [mark.id, mark]));
    const prefix = formKeys.submitted(scope.chainId, scope.rolesMod, "");
    for (const [key, entry] of submissions.current) {
      if (!key.startsWith(prefix) || stored.has(entry.mark.id)) continue;
      // Stored once and gone now: another tab settled or cleared it.
      if (entry.persisted) submissions.current.delete(key);
      else stored.set(entry.mark.id, entry.mark);
    }
    return [...stored.values()];
  }, []);

  const load = useCallback(async (next: Scope) => {
    const token = ++loadToken.current;
    scopeRef.current = next;
    skipAutosave.current = false;
    setRecovered(null);
    setAutosavedAt(null);
    setStatus("loading");
    setError(null);
    setScope(next);
    setMastercopy(null);
    // Read alongside the policy; a failure only leaves the release unknown.
    void readMastercopy(next.rolesMod, next.chainId)
      .then((found) => {
        if (token === loadToken.current) setMastercopy(found);
      })
      .catch(() => {});

    try {
      const mod = await browserRolesReader.read({chainId:next.chainId,address:next.rolesMod});
      if (token !== loadToken.current) return;
      if (!mod) throw new Error("No Roles v2 modifier was found at this address on this network.");
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
    if (!active || !current || !baseHash || !draft) {
      throw new Error("The policy baseline is not loaded.");
    }

    // Read again from the chain: the recent blocks always come straight from
    // the RPC, so a change made since the review opened is seen here.
    const mod = await browserRolesReader.read({chainId:active.chainId,address:active.rolesMod});
    if (!mod) throw new Error("No Roles v2 modifier was found at this address on this network.");
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

    // Read at the last moment before signing, so a submission made in another
    // tab or before a reload counts too. Each one is judged against the state
    // just read: it blocks while the chain still shows its baseline or while
    // the open draft would resend one of its calls.
    const planned = await transactionDigests(diffTransactions(draft, chainState, active.rolesMod));
    const blocking: SubmissionMark[] = [];
    for (const mark of await submissionMarks(active)) {
      const outstanding = await transactionDigests(diffTransactions(mark.policy, chainState, active.rolesMod));
      const verdict = submissionVerdict(mark, { stateHash: hash, planned, outstanding });
      if (verdict === "settled") void forgetSubmission(active, mark.id);
      else if (verdict === "blocks") blocking.push(mark);
    }
    if (!samePolicyScope(scopeRef.current, active)) {
      throw new Error("The open modifier changed while its baseline was checked.");
    }
    if (blocking.length) {
      return {
        fresh: false,
        reason: blocking.some((mark) => mark.status === "sending") ? "outcome-unknown" : "pending",
        previousHash: baseHash,
        currentHash: hash,
        until: Math.max(...blocking.map(blockedUntil)),
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
      return {
        fresh: false,
        reason: "changed",
        previousHash: baseHash,
        currentHash: hash,
      };
    }
    return { fresh: true, baseHash: hash };
  }, [baseHash, current, draft, forgetSubmission, submissionMarks]);

  const beginSubmission = useCallback<PolicyState["beginSubmission"]>(async (transactions) => {
    const active = scopeRef.current;
    if (!active || !baseHash || !draft) throw new Error("The policy baseline is not loaded.");
    const mark: SubmissionMark = {
      id: crypto.randomUUID(),
      baseHash,
      status: "sending",
      sent: await transactionDigests(transactions),
      policy: draft,
      savedAt: Date.now(),
    };
    const key = formKeys.submitted(active.chainId, active.rolesMod, mark.id);
    const entry = { mark, persisted: false };
    submissions.current.set(key, entry);
    activeSubmission.current = { scope: active, key };
    entry.persisted = await rememberSubmission(active, mark);
  }, [baseHash, draft]);

  const markSubmitted = useCallback<PolicyState["markSubmitted"]>((result) => {
    skipAutosave.current = true;
    setRecovered(null);
    setAutosavedAt(null);
    const active = scopeRef.current;
    if (active) void clearSavedForm(formKeys.policy(active.chainId, active.rolesMod));
    const pending = activeSubmission.current;
    activeSubmission.current = null;
    const entry = pending ? submissions.current.get(pending.key) : undefined;
    if (!pending || !entry) return;
    // A partial sequential send reports only the calls that went out; the rest
    // were never broadcast and may be sent again.
    entry.mark = {
      ...entry.mark,
      status: statusAfter(result),
      sent: entry.mark.sent.slice(0, sentCount(result, entry.mark.sent.length)),
      savedAt: Date.now(),
    };
    void rememberSubmission(pending.scope, entry.mark).then((stored) => {
      entry.persisted ||= stored;
    });
  }, []);

  const clearSubmission = useCallback<PolicyState["clearSubmission"]>(async (which) => {
    if (which === "current") {
      const pending = activeSubmission.current;
      activeSubmission.current = null;
      const entry = pending ? submissions.current.get(pending.key) : undefined;
      if (pending && entry) await forgetSubmission(pending.scope, entry.mark.id);
      return;
    }
    const active = scopeRef.current;
    if (!active) return;
    const interrupted = (await submissionMarks(active)).filter((mark) => mark.status === "sending");
    await Promise.all(interrupted.map((mark) => forgetSubmission(active, mark.id)));
  }, [forgetSubmission, submissionMarks]);

  const baseline = useMemo(() => (pristine ? (JSON.parse(pristine) as DraftPolicy) : null), [pristine]);
  const dirty = useMemo(
    () => Boolean(draft && baseline && policyChanged(baseline, draft)),
    [draft, baseline],
  );

  const workingKey = scope ? formKeys.policy(scope.chainId, scope.rolesMod) : null;

  // Debounced autosave of the current diff. Only changes are stored; the
  // unmodified baseline never becomes a "recovered" edit.
  useEffect(() => {
    if (!workingKey || !draft || !dirty || status !== "loaded" || skipAutosave.current) return;
    // Blank, never-started permissions are not worth recovering.
    const savable: DraftPolicy = { ...draft, roles: draft.roles.map((role) => ({ ...role, permissions: role.permissions.filter((permission) => !isBlankPermission(permission)) })) };
    if (!baseline || !policyChanged(baseline, savable)) {
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
  }, [workingKey, draft, dirty, status, baseHash, baseline]);

  // Discarding or reverting the edits leaves nothing to recover.
  useEffect(() => {
    if (!workingKey || status !== "loaded" || dirty) return;
    void clearSavedForm(workingKey);
  }, [workingKey, status, dirty]);

  const plan = useMemo<Plan>(() => {
    if (!draft || !current || !scope) return idlePlan;
    const { state, issues } = toSdkState(draft);
    const planned = withUnwrappers(
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
    // Unsafe patterns block only what this plan would write.
    const unsafe = plannedCallIssues(planned.calls, draft);
    return unsafe.length ? { ...planned, issues: [...planned.issues, ...unsafe] } : planned;
  }, [draft, current, scope]);

  const onChainWarnings = useMemo(() => standingWarnings(current), [current]);
  const legacyPermissions = useMemo(
    () =>
      (draft?.roles ?? []).flatMap((role) =>
        role.permissions.flatMap((permission) => {
          const legacy = legacyEncoding(permission);
          return legacy.found ? [{ roleId: role.id, permissionId: permission.id, fixable: legacy.fixable }] : [];
        }),
      ),
    [draft],
  );

  return {
    status,
    error,
    scope,
    facts,
    current,
    baseHash,
    draft,
    baseline,
    plan,
    dirty,
    load,
    reload,
    setDraft: update,
    discard,
    applyDraft,
    recovered,
    dismissRecovered,
    autosavedAt: dirty ? autosavedAt : null,
    mastercopy,
    standingWarnings: onChainWarnings,
    legacyPermissions,
    recheckBaseline,
    beginSubmission,
    markSubmitted,
    clearSubmission,
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
        // The official indexer lists modifiers on every chain when it answers;
        // the Safe's own enabled modules cover its network either way.
        const [indexed, onChain] = await Promise.allSettled([browserRolesReader.discover(safeAddress), discoverOnChain(safeAddress, chainId)]);
        if (indexed.status === "rejected" && onChain.status === "rejected") throw onChain.reason;
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
