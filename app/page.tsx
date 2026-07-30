"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { isAddress } from "ethers";
import { chainName, safeTransactionUrl, supportedChainIds } from "./lib/chains";
import { parseSignature, shortHex } from "./lib/abi";
import { useAbi, useFunctionNames, useSelectorNames } from "./lib/use-abi";
import type { ResolvedAbi } from "./lib/abi-source";
import {
  conditionOperatorLabels,
  conditionOperators,
  isValuelessOperator,
  type ConditionOperator,
  type DraftAllowance,
  type DraftPermission,
  type DraftPolicy,
  type DraftRole,
} from "./lib/policy";
import { adoptSignature } from "./lib/policy-codec";
import { draftPermissionRisk, highestRisk, riskReason } from "./lib/policy-plan";
import { useDiscoveredMods, usePolicy, type Scope } from "./lib/use-policy";
import { useSafe, verifyModifier } from "./lib/use-safe";
import { useWallet, verifyWalletForModifier } from "./lib/use-wallet";
import { useDrafts, type DraftSummary } from "./lib/use-drafts";
import { SetupDialog, type SetupSubmitter } from "./setup-dialog";

const tabs = ["Permissions", "Members", "Allowances", "Activity"] as const;
type Tab = (typeof tabs)[number];

let sequence = 0;
function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
}

function initials(value: string): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "··";
  const letters = words.map((word) => word[0]).join("");
  // A single-word label (or a bare address) should still yield two characters.
  return (letters.length > 1 ? letters : words[0].slice(0, 2)).slice(0, 2).toUpperCase();
}

/** Closes a dialog on Escape. */
function useDismissOnEscape(onClose: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
}

/**
 * Labels a bare selector using directory candidates.
 *
 * A single candidate is shown as a suggestion, not adopted — several signatures
 * can hash to the same selector, so the name is marked as unconfirmed until it
 * is verified against the contract's own ABI.
 */
function describeSelector(
  selector: string | undefined,
  names: Record<string, string[]>,
): string {
  if (!selector) return "—";
  const candidates = names[selector.toLowerCase()] ?? [];
  if (candidates.length === 1) return `${candidates[0]} ?`;
  if (candidates.length > 1) return `${selector} · ${candidates.length} candidates`;
  return selector;
}

/**
 * How a permission's function should read in the list.
 *
 * Preference order, best evidence first:
 *  1. the target's published ABI, which names the parameters;
 *  2. a readable form already stored on the permission;
 *  3. the canonical signature — correct, but types only;
 *  4. a directory suggestion for a bare selector, marked as unconfirmed;
 *  5. the raw selector.
 */
function describePermissionFunction(
  permission: DraftPermission,
  functionNames: Record<string, Record<string, string>>,
  selectorNames: Record<string, string[]>,
): string {
  const fromAbi = functionNames[permission.targetAddress.trim().toLowerCase()];
  let selector = permission.selector?.toLowerCase();
  if (!selector && permission.signature) {
    try {
      selector = parseSignature(permission.signature).selector.toLowerCase();
    } catch {
      selector = undefined;
    }
  }

  const named = selector ? fromAbi?.[selector] : undefined;
  if (named) return named;
  if (permission.signatureLabel) return permission.signatureLabel;
  if (permission.signature) return permission.signature;
  return describeSelector(permission.selector, selectorNames);
}

/** The best readable form of a permission's function, given a resolved ABI. */
function readableFor(
  permission: DraftPermission,
  abi: ResolvedAbi | null,
): string {
  const declared = abi?.functions.find(
    (entry) => entry.signature === permission.signature,
  );
  return declared?.readable ?? permission.signatureLabel ?? permission.signature;
}

/** Glyph for a permission: its label if it has one, else the target address. */
function permissionGlyph(permission: DraftPermission): string {
  if (permission.name.trim()) return initials(permission.name);
  const address = permission.targetAddress.replace(/^0x/, "");
  return address ? address.slice(0, 2).toUpperCase() : "··";
}

export default function Home() {
  const safe = useSafe();
  const wallet = useWallet();
  const policy = usePolicy();

  const [tab, setTab] = useState<Tab>("Permissions");
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [selectedPermissionId, setSelectedPermissionId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showScope, setShowScope] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [showDrafts, setShowDrafts] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  // Kept after setup so the dialog can confirm the address rather than vanishing.
  const [deployedModifier, setDeployedModifier] = useState<string | null>(null);
  const [showNewRole, setShowNewRole] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [staleBase, setStaleBase] = useState(false);
  const [newRoleName, setNewRoleName] = useState("");
  const [newMemberAddress, setNewMemberAddress] = useState("");
  const [newMemberLabel, setNewMemberLabel] = useState("");

  const { mods, loading: modsLoading, error: modsError } = useDiscoveredMods(
    safe.info?.safeAddress ?? null,
    safe.info?.chainId ?? null,
  );

  const drafts = useDrafts(policy.scope?.chainId ?? null, policy.scope?.rolesMod ?? null);

  /**
   * Opens a modifier, clearing everything tied to the previous one.
   *
   * Draft identity in particular belongs to a single modifier: carrying it across
   * a scope change let a later save overwrite that draft with a different
   * modifier's policy, leaving a row whose stored scope no longer matched its
   * contents.
   */
  const loadPolicy = policy.load;
  const openScope = useCallback(
    (scope: Scope) => {
      setDraftId(null);
      setStaleBase(false);
      setDeployedModifier(null);
      setSelectedRoleId(null);
      setSelectedPermissionId(null);
      void loadPolicy(scope);
    },
    [loadPolicy],
  );

  const saveDraft = useCallback(
    async (existingId: string | null, name = "Policy update") => {
      if (!policy.draft || !policy.scope) return;
      const id = await drafts.save({
        name,
        policy: policy.draft,
        safeAddress:
          safe.info?.safeAddress ?? policy.facts?.avatar ?? policy.scope.rolesMod,
        baseStateHash: policy.baseHash,
        author: wallet.account ?? safe.info?.safeAddress ?? null,
        draftId: existingId,
      });
      setDraftId(id);
      return id;
    },
    [drafts, policy.baseHash, policy.draft, policy.facts, policy.scope, safe.info, wallet.account],
  );

  // With exactly one modifier on the Safe's own chain there is nothing to choose.
  // Modifiers on other chains are listed but never auto-opened, since this Safe
  // cannot govern them.
  useEffect(() => {
    if (policy.scope || safe.mode !== "safe-app" || !safe.info) return;
    const own = mods.filter((mod) => mod.chainId === safe.info!.chainId);
    if (own.length !== 1) return;
    // Deferred out of the effect body: opening a modifier sets several pieces of
    // state, and doing that synchronously here cascades renders.
    const timer = setTimeout(
      () => openScope({ chainId: own[0].chainId, rolesMod: own[0].address }),
      0,
    );
    return () => clearTimeout(timer);
  }, [mods, openScope, policy.scope, safe.info, safe.mode]);

  const draft = policy.draft;
  const roles = useMemo(() => draft?.roles ?? [], [draft]);

  // Bare selectors across the selected role, resolved in one request so an
  // imported policy reads as function names rather than hex.
  const pendingSelectors = useMemo(() => {
    const role = roles.find((entry) => entry.id === selectedRoleId) ?? roles[0];
    if (!role) return [];
    return role.permissions
      .filter((permission) => permission.selector && !permission.signature)
      .map((permission) => permission.selector as string);
  }, [roles, selectedRoleId]);
  const selectorNames = useSelectorNames(pendingSelectors);

  // Readable, parameter-named signatures for every target in the selected role.
  // A types-only signature in the list is what makes a policy hard to review.
  const roleTargets = useMemo(() => {
    const role = roles.find((entry) => entry.id === selectedRoleId) ?? roles[0];
    if (!role) return [];
    return [
      ...new Set(
        role.permissions
          .map((permission) => permission.targetAddress.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
  }, [roles, selectedRoleId]);
  const functionNames = useFunctionNames(policy.scope?.chainId ?? null, roleTargets);

  const selectedRole = useMemo(
    () => roles.find((role) => role.id === selectedRoleId) ?? roles[0] ?? null,
    [roles, selectedRoleId],
  );
  const selectedPermission = useMemo(() => {
    if (!selectedRole) return null;
    return (
      selectedRole.permissions.find(
        (permission) => permission.id === selectedPermissionId,
      ) ??
      selectedRole.permissions[0] ??
      null
    );
  }, [selectedRole, selectedPermissionId]);

  /* ---------------------------- draft mutations --------------------------- */

  const editRole = useCallback(
    (roleId: string, update: (role: DraftRole) => DraftRole) => {
      policy.setDraft((current) => ({
        ...current,
        roles: current.roles.map((role) => (role.id === roleId ? update(role) : role)),
      }));
    },
    [policy],
  );

  const editPermission = useCallback(
    (
      roleId: string,
      permissionId: string,
      update: (permission: DraftPermission) => DraftPermission,
    ) => {
      editRole(roleId, (role) => ({
        ...role,
        permissions: role.permissions.map((permission) =>
          permission.id === permissionId ? update(permission) : permission,
        ),
      }));
    },
    [editRole],
  );

  const addRole = useCallback(() => {
    const name = newRoleName.trim();
    if (!name) return;
    const id = nextId("role");
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 31);
    policy.setDraft((current) => ({
      ...current,
      roles: [
        ...current.roles,
        { id, key, name, description: "", members: [], permissions: [] },
      ],
    }));
    setSelectedRoleId(id);
    setSelectedPermissionId(null);
    setNewRoleName("");
    setShowNewRole(false);
    setTab("Permissions");
  }, [newRoleName, policy]);

  const removeRole = useCallback(
    (roleId: string) => {
      policy.setDraft((current) => ({
        ...current,
        roles: current.roles.filter((entry) => entry.id !== roleId),
      }));
      setSelectedRoleId(null);
      setSelectedPermissionId(null);
    },
    [policy],
  );

  const addPermission = useCallback(() => {
    if (!selectedRole) return;
    const id = nextId("permission");
    editRole(selectedRole.id, (role) => ({
      ...role,
      permissions: [
        ...role.permissions,
        {
          id,
          name: "",
          targetAddress: "",
          mode: "function",
          signature: "",
          send: false,
          delegatecall: false,
          conditions: [],
        },
      ],
    }));
    setSelectedPermissionId(id);
  }, [editRole, selectedRole]);

  const removePermission = useCallback(
    (permissionId: string) => {
      if (!selectedRole) return;
      editRole(selectedRole.id, (role) => ({
        ...role,
        permissions: role.permissions.filter(
          (permission) => permission.id !== permissionId,
        ),
      }));
      setSelectedPermissionId(null);
    },
    [editRole, selectedRole],
  );

  const addMember = useCallback(() => {
    if (!selectedRole || !isAddress(newMemberAddress)) return;
    editRole(selectedRole.id, (role) => ({
      ...role,
      members: [
        ...role.members,
        {
          id: nextId("member"),
          address: newMemberAddress,
          label: newMemberLabel.trim() || undefined,
        },
      ],
    }));
    setNewMemberAddress("");
    setNewMemberLabel("");
  }, [editRole, newMemberAddress, newMemberLabel, selectedRole]);

  const addAllowance = useCallback(() => {
    policy.setDraft((current) => ({
      ...current,
      allowances: [
        ...current.allowances,
        {
          id: nextId("allowance"),
          key: "",
          balance: "0",
          maxRefill: "0",
          refill: "0",
          period: "86400",
          // The refill window starts now, not at the epoch. With timestamp 0 the
          // modifier computes `now / period` elapsed intervals and tops the
          // balance straight up to the ceiling on first use, which would
          // contradict whatever "available now" was set to.
          timestamp: String(Math.floor(Date.now() / 1000)),
        },
      ],
    }));
    setTab("Allowances");
  }, [policy]);

  const editAllowance = useCallback(
    (allowanceId: string, update: (allowance: DraftAllowance) => DraftAllowance) => {
      policy.setDraft((current) => ({
        ...current,
        allowances: current.allowances.map((allowance) =>
          allowance.id === allowanceId ? update(allowance) : allowance,
        ),
      }));
    },
    [policy],
  );

  /* ------------------------------- verification -------------------------- */

  // Two submission paths. Inside the Safe UI the host is authoritative; outside
  // it, a Safe-aware wallet connected as the Safe itself can submit directly.
  const submitVia: "safe-app" | "wallet" | "none" =
    safe.mode === "safe-app"
      ? "safe-app"
      : wallet.status === "connected"
        ? "wallet"
        : "none";

  const verification = useMemo(() => {
    if (submitVia === "wallet") {
      return verifyWalletForModifier({
        account: wallet.account,
        chainId: wallet.chainId,
        owner: policy.facts?.owner ?? null,
        avatar: policy.facts?.avatar ?? null,
        modifierChainId: policy.scope?.chainId ?? null,
      });
    }
    return verifyModifier({
      info: safe.info,
      owner: policy.facts?.owner ?? null,
      avatar: policy.facts?.avatar ?? null,
      rolesMod: policy.scope?.rolesMod ?? "",
      chainId: policy.scope?.chainId ?? null,
    });
  }, [policy.facts, policy.scope, safe.info, submitVia, wallet.account, wallet.chainId]);

  /**
   * The Safe that setup would deploy for.
   *
   * In the Safe UI the host names it. With a Safe-aware wallet the connected
   * account *is* the Safe, so setup works there too — the same reason that path
   * can submit policy changes at all.
   */
  const setupSafeAddress =
    safe.info?.safeAddress ?? (submitVia === "wallet" ? wallet.account : null);

  // Whichever route can actually submit a batch, exposed uniformly so setup does
  // not need to know which one is active.
  const setupSubmitter = useMemo<SetupSubmitter | null>(() => {
    if (submitVia === "safe-app") {
      return { label: "the Safe queue", submit: safe.propose, getCode: safe.getCode };
    }
    if (submitVia === "wallet") {
      return { label: "your wallet", submit: wallet.send, getCode: wallet.getCode };
    }
    return null;
  }, [safe.getCode, safe.propose, submitVia, wallet.getCode, wallet.send]);

  const plan = policy.plan;
  const blockingIssues = plan.issues;
  const canSubmit =
    submitVia !== "none" &&
    verification.ok &&
    !(submitVia === "safe-app" && safe.info?.isReadOnly) &&
    blockingIssues.length === 0 &&
    plan.transactions.length > 0;

  /* --------------------------------- boot -------------------------------- */

  if (safe.mode === "detecting") {
    return (
      <main className="app-shell boot">
        <div className="boot-card">
          <span className="brand-mark" aria-hidden="true">SR</span>
          <h1>SafeRoles</h1>
          <p>Connecting to the Safe host…</p>
        </div>
      </main>
    );
  }

  if (!policy.scope) {
    return (
      <>
        <ScopePicker
          safe={safe}
          mods={mods}
          modsLoading={modsLoading}
          modsError={modsError}
          onSelect={openScope}
          onSetUp={setupSafeAddress ? () => setShowSetup(true) : undefined}
        />
        {showSetup && setupSafeAddress && (
          <SetupDialog
            chainId={safe.info?.chainId ?? wallet.chainId ?? 1}
            safeAddress={setupSafeAddress}
            submitter={setupSubmitter}
            onClose={() => setShowSetup(false)}
            onDone={setDeployedModifier}
          />
        )}
      </>
    );
  }

  if (policy.status === "loading" || policy.status === "idle") {
    return (
      <main className="app-shell boot">
        <div className="boot-card">
          <span className="brand-mark" aria-hidden="true">SR</span>
          <h1>Reading policy</h1>
          <p>
            {shortHex(policy.scope.rolesMod, 10, 8)} on {chainName(policy.scope.chainId)}
          </p>
        </div>
      </main>
    );
  }

  if (policy.status === "error" || !draft) {
    return (
      <main className="app-shell boot">
        <div className="boot-card error">
          <h1>Could not read the policy</h1>
          <p>{policy.error}</p>
          <div className="boot-actions">
            <button className="button secondary" onClick={() => void policy.reload()}>
              Try again
            </button>
            <button className="button ghost" onClick={() => setShowScope(true)}>
              Choose a different modifier
            </button>
          </div>
        </div>
        {showScope && (
          <ScopeDialog
            initial={policy.scope}
            onClose={() => setShowScope(false)}
            onSelect={(scope) => {
              setShowScope(false);
              openScope(scope);
            }}
          />
        )}
      </main>
    );
  }

  /* --------------------------------- render ------------------------------ */

  const filteredRoles = roles.filter((role) =>
    `${role.name} ${role.key}`.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="SafeRoles home">
          <span className="brand-mark" aria-hidden="true">SR</span>
          <span>SafeRoles</span>
        </a>
        <button className="workspace-switcher" onClick={() => setShowScope(true)}>
          <span className="network-dot" aria-hidden="true" />
          <span>
            <b>{chainName(policy.scope.chainId)}</b>
            <small>Modifier · {shortHex(policy.scope.rolesMod)}</small>
          </span>
          <span aria-hidden="true">⌄</span>
        </button>
        <div className="top-actions">
          {safe.mode === "safe-app" && safe.info ? (
            <span className="wallet-chip" title={safe.info.safeAddress}>
              <span className="wallet-status-dot" />
              {shortHex(safe.info.safeAddress)}
              <small>
                Safe App · {safe.info.threshold}/{safe.info.owners.length}
              </small>
            </span>
          ) : wallet.status === "connected" && wallet.account ? (
            <span className="wallet-chip" title={wallet.account}>
              <span className={`wallet-status-dot ${verification.ok ? "" : "warn"}`} />
              {shortHex(wallet.account)}
              <small>
                Wallet ·{" "}
                {wallet.batchSupport === "atomic" ? "atomic batch" : "one call at a time"}
              </small>
            </span>
          ) : wallet.status === "unavailable" ? (
            <span className="wallet-chip readonly">
              <span className="wallet-status-dot idle" />
              Read-only
              <small>No wallet detected</small>
            </span>
          ) : (
            <button
              className="button ghost"
              onClick={() => void wallet.connect()}
              disabled={wallet.status === "connecting"}
            >
              {wallet.status === "connecting" ? "Connecting…" : "Connect wallet"}
            </button>
          )}
          {drafts.available && (
            <button className="button ghost" onClick={() => setShowDrafts(true)}>
              Drafts{drafts.drafts.length > 0 ? ` (${drafts.drafts.length})` : ""}
            </button>
          )}
          <button className="button ghost" onClick={() => void policy.reload()}>
            Refresh
          </button>
          <button
            className="button primary"
            onClick={() => setShowReview(true)}
            disabled={plan.changes.length === 0 && blockingIssues.length === 0}
          >
            {blockingIssues.length > 0
              ? `${blockingIssues.length} to fix`
              : plan.changes.length > 0
                ? `Review ${plan.changes.length} change${plan.changes.length === 1 ? "" : "s"}`
                : "No changes"}
          </button>
        </div>
      </header>

      {!verification.ok && submitVia !== "none" && (
        <div className="banner danger" role="alert">
          <b>
            {submitVia === "wallet"
              ? "This account cannot change this modifier"
              : "This Safe cannot govern this modifier"}
          </b>
          <ul>
            {verification.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
          {submitVia === "wallet" &&
            wallet.chainId !== null &&
            wallet.chainId !== policy.scope.chainId && (
              <button
                className="button secondary"
                onClick={() => void wallet.switchChain(policy.scope!.chainId)}
              >
                Switch wallet to {chainName(policy.scope.chainId)}
              </button>
            )}
        </div>
      )}

      {submitVia === "none" && (
        <div className="banner info">
          <b>Read-only</b>
          <p>
            Live policy is shown and changes are planned. To submit, either open
            SafeRoles as a Safe App, or connect a Safe-aware wallet with the
            owning Safe selected as the active account.
          </p>
          {wallet.error && <p className="error-text">{wallet.error}</p>}
        </div>
      )}

      {deployedModifier && (
        <div className="banner info">
          <b>A new Roles modifier is on its way</b>
          <p>
            Once the Safe transaction is executed, the modifier will be live at{" "}
            <code>{deployedModifier}</code>. It has no roles yet, so it permits nothing
            until one is configured.
          </p>
          <div className="picker-actions">
            <button
              className="button secondary"
              onClick={() =>
                openScope({
                  chainId: policy.scope!.chainId,
                  rolesMod: deployedModifier,
                })
              }
            >
              Open it
            </button>
            <button className="button ghost" onClick={() => setDeployedModifier(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {staleBase && (
        <div className="banner danger" role="alert">
          <b>This draft was based on an older configuration</b>
          <p>
            The modifier has changed since the draft was saved — another proposal has
            likely executed since. The diff is computed against the current live state,
            so re-check it before submitting.
          </p>
        </div>
      )}

      {submitVia === "wallet" && wallet.batchSupport === "sequential" && (
        <div className="banner info">
          <b>This wallet cannot batch atomically</b>
          <p>
            Each planned call will be a separate transaction to confirm, applied one
            at a time. If you stop partway the policy is left partially updated.
          </p>
        </div>
      )}

      <div className="workspace">
        <aside className="role-sidebar">
          <div className="sidebar-heading">
            <div>
              <span className="eyebrow">Live policy</span>
              <h1>Roles</h1>
            </div>
            <button
              className="icon-button"
              aria-label="Create role"
              onClick={() => setShowNewRole(true)}
            >
              +
            </button>
          </div>
          <label className="search">
            <span aria-hidden="true">⌕</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find a role"
              aria-label="Find a role"
            />
          </label>
          <div className="role-list">
            {filteredRoles.map((role) => {
              const roleRisk = highestRisk(role.permissions.map(draftPermissionRisk));
              return (
                <button
                  key={role.id}
                  className={`role-item ${role.id === selectedRole?.id ? "active" : ""}`}
                  onClick={() => {
                    setSelectedRoleId(role.id);
                    setSelectedPermissionId(null);
                    setTab("Permissions");
                  }}
                >
                  <span className="role-glyph" aria-hidden="true">
                    {initials(role.name || role.key)}
                  </span>
                  <span className="role-copy">
                    <b>{role.name || role.key}</b>
                    <small>
                      {role.members.length} member{role.members.length === 1 ? "" : "s"} ·{" "}
                      {role.permissions.length} permission
                      {role.permissions.length === 1 ? "" : "s"}
                    </small>
                  </span>
                  <span className={`risk-dot ${roleRisk.toLowerCase()}`} />
                </button>
              );
            })}
            {roles.length === 0 && (
              <p className="inline-empty">
                This modifier has no roles yet.
              </p>
            )}
          </div>
          <div className="sidebar-foot">
            <span>Modifier</span>
            <code title={policy.scope.rolesMod}>{shortHex(policy.scope.rolesMod, 10, 8)}</code>
            <span className={`health-badge ${verification.ok ? "" : "warn"}`}>
              {safe.mode !== "safe-app"
                ? "Read-only"
                : verification.ok
                  ? "Safe verified"
                  : "Not governed here"}
            </span>
          </div>
        </aside>

        <section className="role-workspace">
          {selectedRole ? (
            <>
              <div className="breadcrumbs">
                {chainName(policy.scope.chainId)} <span>/</span>{" "}
                {policy.facts ? shortHex(policy.facts.avatar) : "Safe"} <span>/</span> Roles
              </div>
              <header className="role-header">
                <div>
                  <div className="title-row">
                    <input
                      className="title-input"
                      value={selectedRole.name}
                      aria-label="Role name"
                      placeholder="Role name"
                      onChange={(event) =>
                        editRole(selectedRole.id, (role) => ({
                          ...role,
                          name: event.target.value,
                        }))
                      }
                    />
                  </div>
                  <input
                    className="description-input"
                    value={selectedRole.description}
                    aria-label="Role description"
                    placeholder="What is this role for? (stored in your draft, not on chain)"
                    onChange={(event) =>
                      editRole(selectedRole.id, (role) => ({
                        ...role,
                        description: event.target.value,
                      }))
                    }
                  />
                  <label className="role-key-field">
                    <span>role key</span>
                    <input
                      className="mono-input"
                      value={selectedRole.key}
                      aria-label="Role key"
                      placeholder="role_key"
                      onChange={(event) =>
                        editRole(selectedRole.id, (role) => ({
                          ...role,
                          key: event.target.value,
                        }))
                      }
                    />
                    <small>
                      The role&apos;s on-chain identity, and how to resolve two roles
                      sharing a key. Changing it on a deployed role plans a teardown of
                      the old key and a rebuild under the new one — the review shows
                      every call.
                    </small>
                  </label>
                </div>
                <button
                  className="delete-link"
                  onClick={() => removeRole(selectedRole.id)}
                >
                  Remove role
                </button>
              </header>

              <nav className="tabs" aria-label="Role sections">
                {tabs.map((item) => (
                  <button
                    key={item}
                    className={tab === item ? "active" : ""}
                    onClick={() => setTab(item)}
                  >
                    {item}
                    {item === "Permissions" && <span>{selectedRole.permissions.length}</span>}
                    {item === "Members" && <span>{selectedRole.members.length}</span>}
                    {item === "Allowances" && <span>{draft.allowances.length}</span>}
                  </button>
                ))}
              </nav>

              {tab === "Permissions" && (
                <div className="content-grid">
                  <section className="content-panel">
                    <div className="panel-heading">
                      <div>
                        <span className="eyebrow">Effective policy</span>
                        <h3>Permissions</h3>
                        <p>Every call is denied unless it matches a permission below.</p>
                      </div>
                      <button className="button secondary" onClick={addPermission}>
                        + Add permission
                      </button>
                    </div>

                    {selectedRole.permissions.length === 0 ? (
                      <div className="empty-state">
                        <span className="empty-mark" aria-hidden="true">∅</span>
                        <h3>No permissions</h3>
                        <p>This role cannot execute anything until a target or function is cleared.</p>
                        <button className="button primary" onClick={addPermission}>
                          Add first permission
                        </button>
                      </div>
                    ) : (
                      <div className="permission-list">
                        <div className="permission-columns" aria-hidden="true">
                          <span>Target &amp; function</span>
                          <span>Constraints</span>
                          <span>Risk</span>
                        </div>
                        {selectedRole.permissions.map((permission) => {
                          const risk = draftPermissionRisk(permission);
                          const active = permission.conditions.filter(
                            (condition) => condition.operator !== "pass",
                          );
                          return (
                            <button
                              key={permission.id}
                              className={`permission-row ${
                                permission.id === selectedPermission?.id ? "active" : ""
                              }`}
                              onClick={() => setSelectedPermissionId(permission.id)}
                            >
                              <span className="target-cell">
                                <span className="contract-mark" aria-hidden="true">
                                  {permissionGlyph(permission)}
                                </span>
                                <span>
                                  <b>{permission.name || shortHex(permission.targetAddress) || "New target"}</b>
                                  <code
                                    title={
                                      permission.mode === "target"
                                        ? "Every function on this contract"
                                        : describePermissionFunction(
                                            permission,
                                            functionNames,
                                            selectorNames,
                                          )
                                    }
                                  >
                                    {permission.mode === "target"
                                      ? "all functions"
                                      : describePermissionFunction(
                                          permission,
                                          functionNames,
                                          selectorNames,
                                        )}
                                  </code>
                                  <small>{permission.targetAddress || "no address yet"}</small>
                                </span>
                              </span>
                              <span className="constraint-cell">
                                {permission.mode === "target" ? (
                                  <span className="condition-chip dangerous">All functions</span>
                                ) : permission.rawCondition ? (
                                  <span className="condition-chip locked">Deployed condition</span>
                                ) : active.length ? (
                                  active.slice(0, 2).map((condition) => (
                                    <span className="condition-chip" key={condition.id}>
                                      arg {condition.paramIndex} ·{" "}
                                      {conditionOperatorLabels[condition.operator]}
                                    </span>
                                  ))
                                ) : (
                                  <span className="condition-chip neutral">Unconstrained</span>
                                )}
                                {permission.delegatecall && (
                                  <span className="condition-chip dangerous">delegatecall</span>
                                )}
                              </span>
                              <span className={`risk-badge ${risk.toLowerCase()}`}>{risk}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </section>

                  <aside className="inspector">
                    {selectedPermission ? (
                      <PermissionInspector
                        key={selectedPermission.id}
                        permission={selectedPermission}
                        allowances={draft.allowances}
                        chainId={policy.scope.chainId}
                        selectorNames={selectorNames}
                        onChange={(update) =>
                          editPermission(selectedRole.id, selectedPermission.id, update)
                        }
                        onRemove={() => removePermission(selectedPermission.id)}
                      />
                    ) : (
                      <div className="inspector-empty">
                        <span>←</span>
                        <p>Select a permission to inspect its exact scope.</p>
                      </div>
                    )}
                  </aside>
                </div>
              )}

              {tab === "Members" && (
                <section className="single-panel">
                  <div className="panel-heading">
                    <div>
                      <span className="eyebrow">Role assignment</span>
                      <h3>Members</h3>
                      <p>Members may execute only this role&apos;s permissions.</p>
                    </div>
                  </div>
                  <div className="add-member-row">
                    <input
                      className="mono-input"
                      value={newMemberAddress}
                      placeholder="0x… member address"
                      aria-label="Member address"
                      onChange={(event) => setNewMemberAddress(event.target.value.trim())}
                    />
                    <input
                      value={newMemberLabel}
                      placeholder="Label (optional, not stored on chain)"
                      aria-label="Member label"
                      onChange={(event) => setNewMemberLabel(event.target.value)}
                    />
                    <button
                      className="button secondary"
                      onClick={addMember}
                      disabled={!isAddress(newMemberAddress)}
                    >
                      Add member
                    </button>
                  </div>
                  {newMemberAddress && !isAddress(newMemberAddress) && (
                    <small className="error-text">Enter a complete 20-byte address.</small>
                  )}
                  <div className="member-table">
                    <div className="table-head">
                      <span>Member</span>
                      <span>Label</span>
                      <span>Address</span>
                      <span />
                    </div>
                    {selectedRole.members.map((member) => (
                      <div className="member-row" key={member.id}>
                        <span className="member-name">
                          <span className="avatar">{initials(member.label ?? member.address.slice(2, 4))}</span>
                          <b>{member.label ?? "Unlabelled"}</b>
                        </span>
                        <span className="type-badge">{member.label ? "labelled" : "—"}</span>
                        <code title={member.address}>{shortHex(member.address, 10, 8)}</code>
                        <button
                          onClick={() =>
                            editRole(selectedRole.id, (role) => ({
                              ...role,
                              members: role.members.filter((item) => item.id !== member.id),
                            }))
                          }
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                    {selectedRole.members.length === 0 && (
                      <div className="table-empty">No members assigned.</div>
                    )}
                  </div>
                </section>
              )}

              {tab === "Allowances" && (
                <section className="single-panel">
                  <div className="panel-heading">
                    <div>
                      <span className="eyebrow">Rate limits</span>
                      <h3>Allowances</h3>
                      <p>
                        Shared across the whole modifier. Amounts are integer base units of
                        whichever asset the condition constrains.
                      </p>
                    </div>
                    <button className="button secondary" onClick={addAllowance}>
                      + Add allowance
                    </button>
                  </div>
                  <div className="allowance-list">
                    {draft.allowances.map((allowance) => (
                      <AllowanceEditor
                        key={allowance.id}
                        allowance={allowance}
                        onChange={(update) => editAllowance(allowance.id, update)}
                        onRemove={() =>
                          policy.setDraft((current) => ({
                            ...current,
                            allowances: current.allowances.filter(
                              (item) => item.id !== allowance.id,
                            ),
                          }))
                        }
                      />
                    ))}
                    {draft.allowances.length === 0 && (
                      <div className="empty-state compact">
                        <h3>No allowances</h3>
                        <p>Add one to cap cumulative spending independently of call frequency.</p>
                      </div>
                    )}
                  </div>
                </section>
              )}

              {tab === "Activity" && (
                <ActivityPanel
                  chainId={policy.scope.chainId}
                  rolesMod={policy.scope.rolesMod}
                />
              )}
            </>
          ) : (
            <div className="empty-state">
              <span className="empty-mark" aria-hidden="true">∅</span>
              <h3>No roles on this modifier</h3>
              <p>Create a role to start describing what it may do.</p>
              <button className="button primary" onClick={() => setShowNewRole(true)}>
                Create a role
              </button>
            </div>
          )}
        </section>
      </div>

      {(plan.changes.length > 0 || blockingIssues.length > 0) && (
        <div className="change-bar">
          <div>
            <span className="change-count">
              {blockingIssues.length > 0 ? "!" : plan.changes.length}
            </span>
            <span>
              <b>
                {blockingIssues.length > 0
                  ? `${blockingIssues.length} problem${blockingIssues.length === 1 ? "" : "s"} to fix`
                  : `${plan.transactions.length} onchain call${plan.transactions.length === 1 ? "" : "s"} planned`}
              </b>
              <small>
                {blockingIssues.length > 0 ? (
                  "No diff is computed while a value is invalid."
                ) : (
                  <>
                    Highest risk:{" "}
                    <span className={`risk-text ${plan.risk.toLowerCase()}`}>{plan.risk}</span>
                  </>
                )}
              </small>
            </span>
          </div>
          <div>
            <button onClick={policy.discard} disabled={!policy.dirty}>
              Discard edits
            </button>
            {drafts.available && (
              <button
                onClick={() => {
                  // Naming a new draft needs a field, not `window.prompt`, which a
                  // sandboxed iframe — the Safe App's environment — can block.
                  if (!draftId) {
                    setShowDrafts(true);
                    return;
                  }
                  void saveDraft(draftId);
                }}
                disabled={drafts.busy}
              >
                {draftId ? "Save draft" : "Save as draft…"}
              </button>
            )}
            <button className="button primary" onClick={() => setShowReview(true)}>
              Review →
            </button>
          </div>
        </div>
      )}

      {showNewRole && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal small" role="dialog" aria-modal="true" aria-labelledby="new-role-title">
            <div className="modal-heading">
              <div>
                <span className="eyebrow">RBAC</span>
                <h2 id="new-role-title">Create a role</h2>
              </div>
              <button className="icon-button" aria-label="Close" onClick={() => setShowNewRole(false)}>×</button>
            </div>
            <label className="modal-field">
              <span>Role name</span>
              <input
                autoFocus
                value={newRoleName}
                onChange={(event) => setNewRoleName(event.target.value)}
                placeholder="e.g. Treasury Operator"
                onKeyDown={(event) => {
                  if (event.key === "Enter") addRole();
                }}
              />
              <small>
                On-chain key:{" "}
                <code>
                  {newRoleName.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 31) || "role_key"}
                </code>
              </small>
            </label>
            <div className="modal-actions">
              <button onClick={() => setShowNewRole(false)}>Cancel</button>
              <button className="button primary" onClick={addRole} disabled={!newRoleName.trim()}>
                Create role
              </button>
            </div>
          </section>
        </div>
      )}

      {showDrafts && (
        <DraftsDialog
          drafts={drafts}
          activeDraftId={draftId}
          currentBaseHash={policy.baseHash}
          canSave={policy.dirty || plan.changes.length > 0}
          onSave={async (name) => {
            await saveDraft(draftId, name);
            setShowDrafts(false);
          }}
          onClose={() => setShowDrafts(false)}
          onOpen={async (summary) => {
            const opened = await drafts.open(summary.id);
            policy.applyDraft(opened.policy);
            setDraftId(summary.id);
            // A draft saved against a different baseline still shows a diff, but
            // against today's live state — say so rather than imply it is fresh.
            setStaleBase(
              Boolean(
                opened.baseStateHash &&
                  policy.baseHash &&
                  opened.baseStateHash !== policy.baseHash,
              ),
            );
            setSelectedRoleId(null);
            setSelectedPermissionId(null);
            setShowDrafts(false);
          }}
        />
      )}

      {showScope && (
        <ScopeDialog
          initial={policy.scope}
          onClose={() => setShowScope(false)}
          onSetUp={
            setupSafeAddress
              ? () => {
                  setShowScope(false);
                  setShowSetup(true);
                }
              : undefined
          }
          onSelect={(scope) => {
            setShowScope(false);
            openScope(scope);
          }}
        />
      )}

      {showSetup && setupSafeAddress && (
        <SetupDialog
          chainId={policy.scope.chainId}
          safeAddress={setupSafeAddress}
          submitter={setupSubmitter}
          onClose={() => setShowSetup(false)}
          onDone={setDeployedModifier}
        />
      )}

      {showReview && (
        <ReviewDialog
          plan={plan}
          draft={draft}
          scope={policy.scope}
          safe={safe}
          wallet={wallet}
          submitVia={submitVia}
          verification={verification}
          canSubmit={canSubmit}
          onClose={() => setShowReview(false)}
          onSubmitted={() => void policy.reload()}
        />
      )}
    </main>
  );
}

/* ========================================================================== */
/*                              Permission editor                             */
/* ========================================================================== */

function PermissionInspector({
  permission,
  allowances,
  chainId,
  selectorNames,
  onChange,
  onRemove,
}: {
  permission: DraftPermission;
  allowances: DraftAllowance[];
  chainId: number;
  selectorNames: Record<string, string[]>;
  onChange: (update: (permission: DraftPermission) => DraftPermission) => void;
  onRemove: () => void;
}) {
  const risk = draftPermissionRisk(permission);
  const [signatureDraft, setSignatureDraft] = useState("");
  const [adoptNote, setAdoptNote] = useState<string | null>(null);
  const [showManualAbi, setShowManualAbi] = useState(false);
  const [manualAbi, setManualAbi] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);

  const abi = useAbi(chainId, permission.targetAddress);

  // An imported permission is identified only by selector; the signature has to
  // be supplied and verified before its condition can be shown or edited.
  const needsSignature = Boolean(permission.selector && !permission.signature);

  // The ABI is the strongest evidence for an imported selector: a signature
  // taken from it hashes to that selector by construction.
  const abiMatch = useMemo(() => {
    if (!needsSignature || !permission.selector || !abi.abi) return null;
    return (
      abi.abi.functions.find(
        (entry) => entry.selector.toLowerCase() === permission.selector!.toLowerCase(),
      ) ?? null
    );
  }, [abi.abi, needsSignature, permission.selector]);

  useEffect(() => {
    if (!abiMatch) return;
    // Deferred out of the effect body. Adopting clears `selector`, so `abiMatch`
    // becomes null on the next pass and this settles after one adoption.
    const timer = setTimeout(() => {
      const result = adoptSignature(permission, abiMatch.signature);
      if (result.permission.signature) {
        setAdoptNote(result.editable ? null : (result.note ?? null));
        onChange(() => result.permission);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [abiMatch, onChange, permission]);

  const candidates = permission.selector
    ? (selectorNames[permission.selector.toLowerCase()] ?? [])
    : [];

  // Parameter names and types for labelling the condition rows.
  //
  // The ABI is preferred over the signature: a canonical signature carries only
  // types, so `vault`/`minOut` would degrade to `arg0`/`arg1` without it.
  const params = useMemo(() => {
    if (!permission.signature) return null;

    const declared = abi.abi?.functions.find(
      (entry) => entry.signature === permission.signature,
    );
    if (declared) {
      return declared.inputs.map((input, index) => ({
        index,
        label: input.name,
        type: input.type,
      }));
    }

    try {
      return parseSignature(permission.signature).params.map((param, index) => ({
        index,
        label: param.name || `arg${index}`,
        type: param.type,
      }));
    } catch {
      return null;
    }
  }, [abi.abi, permission.signature]);

  async function submitManualAbi() {
    setManualError(null);
    try {
      await abi.saveManual(manualAbi);
      setShowManualAbi(false);
      setManualAbi("");
    } catch (error) {
      setManualError(error instanceof Error ? error.message : "That ABI was rejected.");
    }
  }

  return (
    <>
      <div className="inspector-heading">
        <div>
          <span className="eyebrow">Permission</span>
          <h3>{permission.name || shortHex(permission.targetAddress) || "New permission"}</h3>
        </div>
        <span className={`risk-badge ${risk.toLowerCase()}`}>{risk}</span>
      </div>

      <div className="field-grid">
        <label>
          <span>Label</span>
          <input
            value={permission.name}
            placeholder="e.g. USDC"
            onChange={(event) =>
              onChange((current) => ({ ...current, name: event.target.value }))
            }
          />
          <small>Display only. Never encoded.</small>
        </label>
        <label>
          <span>Target address</span>
          <input
            className="mono-input"
            value={permission.targetAddress}
            placeholder="0x…"
            onChange={(event) =>
              onChange((current) => ({ ...current, targetAddress: event.target.value.trim() }))
            }
          />
          {permission.targetAddress && !isAddress(permission.targetAddress) && (
            <small className="error-text">Enter a complete 20-byte address.</small>
          )}
          <AbiStatusLine
            abi={abi}
            onPaste={() => setShowManualAbi(true)}
            onForget={() => void abi.forget()}
          />
        </label>
        <label>
          <span>Scope</span>
          <select
            value={permission.mode}
            onChange={(event) =>
              onChange((current) => ({
                ...current,
                mode: event.target.value as DraftPermission["mode"],
              }))
            }
          >
            <option value="function">One function</option>
            <option value="target">Entire contract</option>
          </select>
        </label>
        <div className="checkbox-field">
          <span>Execution</span>
          <label className="check">
            <input
              type="checkbox"
              checked={permission.send}
              onChange={(event) =>
                onChange((current) => ({ ...current, send: event.target.checked }))
              }
            />
            May send value
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={permission.delegatecall}
              onChange={(event) =>
                onChange((current) => ({ ...current, delegatecall: event.target.checked }))
              }
            />
            May delegatecall
          </label>
        </div>

        {permission.mode === "function" && (
          <label className="span-2">
            <span>Function</span>

            {/* With an ABI, functions are chosen from what the contract actually
                declares rather than typed from memory. */}
            {abi.abi && abi.abi.functions.length > 0 && (
              <select
                value={permission.signature}
                aria-label="Function"
                onChange={(event) => {
                  const chosen = event.target.value;
                  if (!chosen) return;
                  setAdoptNote(null);
                  const declared = abi.abi?.functions.find(
                    (entry) => entry.signature === chosen,
                  );
                  onChange((current) => ({
                    ...current,
                    signature: chosen,
                    // Display only; the canonical signature above is what encodes.
                    signatureLabel: declared?.readable,
                    selector: undefined,
                    rawCondition: undefined,
                    // Conditions are positional, so they cannot carry over to a
                    // different function's parameter list.
                    conditions: current.signature === chosen ? current.conditions : [],
                  }));
                }}
              >
                <option value="">Select a function…</option>
                <optgroup label="State-changing">
                  {abi.abi.functions
                    .filter((entry) => !entry.readOnly)
                    .map((entry) => (
                      <option key={entry.selector} value={entry.signature}>
                        {entry.readable}
                      </option>
                    ))}
                </optgroup>
                <optgroup label="Read-only (granting these achieves nothing)">
                  {abi.abi.functions
                    .filter((entry) => entry.readOnly)
                    .map((entry) => (
                      <option key={entry.selector} value={entry.signature}>
                        {entry.readable}
                      </option>
                    ))}
                </optgroup>
              </select>
            )}

            {needsSignature && !abi.abi && (
              <>
                {candidates.length > 0 && (
                  <div className="candidate-list">
                    <small>
                      {candidates.length === 1
                        ? "One known signature hashes to this selector:"
                        : `${candidates.length} signatures hash to this selector — a selector is a truncated hash, so pick the one this contract actually declares:`}
                    </small>
                    {candidates.map((candidate) => (
                      <button
                        key={candidate}
                        className="button secondary"
                        onClick={() => {
                          const result = adoptSignature(permission, candidate);
                          setAdoptNote(result.note ?? null);
                          if (result.permission.signature) onChange(() => result.permission);
                        }}
                      >
                        {candidate}
                      </button>
                    ))}
                  </div>
                )}
                <div className="adopt-row">
                  <input
                    className="mono-input"
                    value={signatureDraft}
                    placeholder="transfer(address,uint256)"
                    onChange={(event) => setSignatureDraft(event.target.value)}
                  />
                  <button
                    className="button secondary"
                    onClick={() => {
                      const result = adoptSignature(permission, signatureDraft);
                      setAdoptNote(result.note ?? null);
                      if (result.permission.signature) onChange(() => result.permission);
                    }}
                  >
                    Verify
                  </button>
                </div>
                <small>
                  Deployed as selector <code>{permission.selector}</code>. The modifier stores
                  only the selector, so any signature is checked against it before use.
                </small>
              </>
            )}

            {!needsSignature && !abi.abi && (
              <input
                className="mono-input"
                value={permission.signature}
                placeholder="transfer(address,uint256)"
                onChange={(event) =>
                  onChange((current) => ({ ...current, signature: event.target.value }))
                }
              />
            )}

            {permission.signature && (
              <small className="mono-note">
                <code>{readableFor(permission, abi.abi)}</code>
                {params && params.length > 0
                  ? ` · ${params.map((param) => `${param.label}: ${param.type}`).join(", ")}`
                  : " · no parameters"}
              </small>
            )}
            {adoptNote && <small className="error-text">{adoptNote}</small>}
          </label>
        )}
      </div>

      {showManualAbi && (
        <div className="manual-abi">
          <div className="section-label">
            <div>
              <b>Paste an ABI</b>
              <span>Stored for this contract on this chain, and reused next time</span>
            </div>
            <button onClick={() => setShowManualAbi(false)}>Cancel</button>
          </div>
          <textarea
            className="mono-input"
            rows={6}
            value={manualAbi}
            placeholder={'[{"type":"function","name":"transfer",…}]\n\nor one signature per line:\nfunction transfer(address to, uint256 amount)'}
            onChange={(event) => setManualAbi(event.target.value)}
          />
          {manualError && <small className="error-text">{manualError}</small>}
          <button
            className="button primary"
            disabled={!manualAbi.trim()}
            onClick={() => void submitManualAbi()}
          >
            Use this ABI
          </button>
        </div>
      )}

      {permission.mode === "function" && (
        <div className="condition-section">
          <div className="section-label">
            <div>
              <b>Parameter conditions</b>
              <span>All must hold for the call to be allowed</span>
            </div>
            {!permission.rawCondition && !needsSignature && (
              <button
                onClick={() =>
                  onChange((current) => ({
                    ...current,
                    conditions: [
                      ...current.conditions,
                      {
                        id: nextId("condition"),
                        paramIndex: current.conditions.length,
                        operator: "eq",
                        value: "",
                      },
                    ],
                  }))
                }
              >
                + Add
              </button>
            )}
          </div>

          {permission.rawCondition ? (
            <div className="guardrail-callout locked">
              <b>Deployed condition preserved</b>
              <p>
                This permission&apos;s condition uses nesting or operators this editor cannot
                represent. It is kept exactly as deployed and will not be rewritten. Editing it
                requires the Zodiac Roles app.
              </p>
            </div>
          ) : needsSignature ? (
            <p className="inline-empty">Verify the function signature to edit conditions.</p>
          ) : (
            <div className="condition-editor-list">
              {permission.conditions.map((condition, index) => (
                <div className="condition-editor" key={condition.id}>
                  <span className="condition-index">{index + 1}</span>
                  <div>
                    {/* With the signature known, parameters are chosen by name
                        instead of by counting positions. */}
                    {params && params.length > 0 ? (
                      <select
                        aria-label={`Condition ${index + 1} parameter`}
                        value={condition.paramIndex}
                        onChange={(event) =>
                          onChange((current) => ({
                            ...current,
                            conditions: current.conditions.map((item) =>
                              item.id === condition.id
                                ? { ...item, paramIndex: Number(event.target.value) }
                                : item,
                            ),
                          }))
                        }
                      >
                        {params.map((param) => (
                          <option key={param.index} value={param.index}>
                            {param.label} ({param.type})
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="condition-position"
                        type="number"
                        min="0"
                        aria-label={`Condition ${index + 1} parameter position`}
                        title="Zero-based parameter position"
                        value={condition.paramIndex}
                        onChange={(event) =>
                          onChange((current) => ({
                            ...current,
                            conditions: current.conditions.map((item) =>
                              item.id === condition.id
                                ? { ...item, paramIndex: Math.max(0, Number(event.target.value)) }
                                : item,
                            ),
                          }))
                        }
                      />
                    )}
                    <select
                      aria-label={`Condition ${index + 1} operator`}
                      value={condition.operator}
                      onChange={(event) =>
                        onChange((current) => ({
                          ...current,
                          conditions: current.conditions.map((item) =>
                            item.id === condition.id
                              ? { ...item, operator: event.target.value as ConditionOperator }
                              : item,
                          ),
                        }))
                      }
                    >
                      {conditionOperators.map((operator) => (
                        <option key={operator} value={operator}>
                          {conditionOperatorLabels[operator]}
                        </option>
                      ))}
                    </select>
                    {condition.operator === "withinAllowance" ? (
                      <select
                        aria-label={`Condition ${index + 1} allowance`}
                        value={condition.value}
                        onChange={(event) =>
                          onChange((current) => ({
                            ...current,
                            conditions: current.conditions.map((item) =>
                              item.id === condition.id
                                ? { ...item, value: event.target.value }
                                : item,
                            ),
                          }))
                        }
                      >
                        <option value="">Select an allowance…</option>
                        {allowances.map((allowance) => (
                          <option key={allowance.id} value={allowance.key}>
                            {allowance.key || "(unnamed)"}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        aria-label={`Condition ${index + 1} value`}
                        className="mono-input"
                        value={condition.value}
                        placeholder={
                          isValuelessOperator(condition.operator) ? "—" : "Comparison value"
                        }
                        disabled={isValuelessOperator(condition.operator)}
                        onChange={(event) =>
                          onChange((current) => ({
                            ...current,
                            conditions: current.conditions.map((item) =>
                              item.id === condition.id
                                ? { ...item, value: event.target.value }
                                : item,
                            ),
                          }))
                        }
                      />
                    )}
                    <button
                      className="row-remove"
                      aria-label={`Remove condition ${index + 1}`}
                      onClick={() =>
                        onChange((current) => ({
                          ...current,
                          conditions: current.conditions.filter(
                            (item) => item.id !== condition.id,
                          ),
                        }))
                      }
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
              {permission.conditions.length === 0 && (
                <p className="inline-empty">
                  No parameter is constrained, so any argument is permitted.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {risk !== "Low" && (
        <div className={`guardrail-callout ${risk.toLowerCase()}`}>
          <b>{risk}-risk permission</b>
          <p>{riskReason(permission)}</p>
        </div>
      )}

      <button className="delete-link" onClick={onRemove}>
        Remove permission
      </button>
    </>
  );
}

/** Reports where a contract's ABI came from, or offers manual entry. */
function AbiStatusLine({
  abi,
  onPaste,
  onForget,
}: {
  abi: ReturnType<typeof useAbi>;
  onPaste: () => void;
  onForget: () => void;
}) {
  if (abi.status === "idle") return null;

  if (abi.status === "loading") {
    return <small className="abi-status">Looking up the ABI…</small>;
  }

  if (abi.status === "found" && abi.abi) {
    const source =
      abi.abi.source === "manual" ? "supplied by hand" : `via ${abi.abi.source}`;
    return (
      <small className="abi-status found">
        <b>{abi.abi.name ?? "Verified contract"}</b> · {abi.abi.functions.length} functions ·{" "}
        {source}
        {abi.abi.implementation && (
          <>
            {" · "}
            {abi.abi.proxyType ?? "proxy"} → {shortHex(abi.abi.implementation)}
          </>
        )}
        <button className="link-button" onClick={onForget}>
          {abi.abi.source === "manual" ? "remove" : "refresh"}
        </button>
      </small>
    );
  }

  return (
    <small className="abi-status missing">
      {abi.reason ?? "No ABI is available."}
      <button className="link-button" onClick={onPaste}>
        paste an ABI
      </button>
    </small>
  );
}

/* ========================================================================== */
/*                              Allowance editor                              */
/* ========================================================================== */

function AllowanceEditor({
  allowance,
  onChange,
  onRemove,
}: {
  allowance: DraftAllowance;
  onChange: (update: (allowance: DraftAllowance) => DraftAllowance) => void;
  onRemove: () => void;
}) {
  const set = (field: keyof DraftAllowance) => (value: string) =>
    onChange((current) => ({ ...current, [field]: value }));

  const periodHours = Number(allowance.period) / 3600;

  return (
    <article className="allowance-card editable">
      <div className="allowance-head">
        <input
          className="mono-input"
          value={allowance.key}
          placeholder="allowance_key"
          aria-label="Allowance key"
          onChange={(event) => set("key")(event.target.value)}
        />
        <button className="row-remove" aria-label="Remove allowance" onClick={onRemove}>×</button>
      </div>
      <div className="allowance-grid-fields">
        <label>
          <span>Available now</span>
          <input
            className="mono-input"
            value={allowance.balance}
            onChange={(event) => set("balance")(event.target.value)}
          />
          <small>Current unspent budget. Raising this is a deliberate top-up.</small>
        </label>
        <label>
          <span>Ceiling</span>
          <input
            className="mono-input"
            value={allowance.maxRefill}
            onChange={(event) => set("maxRefill")(event.target.value)}
          />
          <small>The most the budget can ever hold.</small>
        </label>
        <label>
          <span>Refill amount</span>
          <input
            className="mono-input"
            value={allowance.refill}
            onChange={(event) => set("refill")(event.target.value)}
          />
          <small>Added each period, capped at the ceiling.</small>
        </label>
        <label>
          <span>Period (seconds)</span>
          <input
            className="mono-input"
            value={allowance.period}
            onChange={(event) => set("period")(event.target.value)}
          />
          <small>
            {Number.isFinite(periodHours) && periodHours > 0
              ? `${periodHours} hour${periodHours === 1 ? "" : "s"}`
              : "0 means a one-time budget that never refills."}
          </small>
        </label>
      </div>
    </article>
  );
}

/* ========================================================================== */
/*                                  Activity                                  */
/* ========================================================================== */

type ProposalRow = {
  id: string;
  safeTxHash: string;
  callCount: number;
  risk: string;
  proposedBy: string | null;
  createdAt: number;
};

function ActivityPanel({ chainId, rolesMod }: { chainId: number; rolesMod: string }) {
  const [rows, setRows] = useState<ProposalRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(
          `/api/proposals?chainId=${chainId}&rolesMod=${rolesMod}`,
        );
        const body = (await response.json()) as {
          proposals?: ProposalRow[];
          error?: string;
        };
        if (cancelled) return;
        if (body.error) setError(body.error);
        else setRows(body.proposals ?? []);
      } catch {
        if (!cancelled) setError("Could not load proposal history.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chainId, rolesMod]);

  return (
    <section className="single-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Audit trail</span>
          <h3>Proposals from this console</h3>
          <p>
            Recorded per modifier, so history survives role renames. Execution status lives
            in the Safe.
          </p>
        </div>
      </div>
      <div className="timeline">
        {error && <p className="inline-empty">{error}</p>}
        {rows?.map((row) => {
          const url = safeTransactionUrl(chainId, rolesMod, row.safeTxHash);
          return (
            <div className="timeline-item" key={row.id}>
              <span className="change-glyph updated">~</span>
              <div>
                <b>
                  {row.callCount} call{row.callCount === 1 ? "" : "s"} proposed
                </b>
                <span>
                  {new Date(row.createdAt).toLocaleString()}
                  {row.proposedBy ? ` · by ${shortHex(row.proposedBy)}` : ""}
                </span>
                <code>{shortHex(row.safeTxHash, 12, 10)}</code>
              </div>
              <span className={`risk-badge ${row.risk.toLowerCase()}`}>{row.risk}</span>
              {url && (
                <a className="button ghost" href={url} target="_blank" rel="noreferrer">
                  Open ↗
                </a>
              )}
            </div>
          );
        })}
        {rows?.length === 0 && !error && (
          <p className="inline-empty">No proposals have been submitted from this console yet.</p>
        )}
        {!rows && !error && <p className="inline-empty">Loading…</p>}
      </div>
    </section>
  );
}

/* ========================================================================== */
/*                              Scope selection                               */
/* ========================================================================== */

function ScopePicker({
  safe,
  mods,
  modsLoading,
  modsError,
  onSelect,
  onSetUp,
}: {
  safe: ReturnType<typeof useSafe>;
  mods: { address: string; chainId: number; owner: string; avatar: string }[];
  modsLoading: boolean;
  modsError: string | null;
  onSelect: (scope: Scope) => void;
  /** Undefined outside the Safe UI, where the target Safe is unknown. */
  onSetUp?: () => void;
}) {
  const [manual, setManual] = useState(false);

  if (safe.mode === "safe-app" && safe.info && !manual) {
    return (
      <main className="app-shell boot">
        <div className="boot-card wide">
          <span className="brand-mark" aria-hidden="true">SR</span>
          <h1>Choose a Roles modifier</h1>
          <p>
            Attached to {shortHex(safe.info.safeAddress)} on {chainName(safe.info.chainId)}.
          </p>
          {modsLoading && <p className="inline-empty">Looking up modifiers…</p>}
          {modsError && <p className="error-text">{modsError}</p>}
          <div className="mod-list">
            {mods.map((mod) => {
              const governed =
                mod.owner.toLowerCase() === safe.info!.safeAddress.toLowerCase() &&
                mod.avatar.toLowerCase() === safe.info!.safeAddress.toLowerCase();
              // A Safe can only govern a modifier on its own chain, but showing
              // the others is how you find a Safe's full footprint.
              const sameChain = mod.chainId === safe.info!.chainId;
              return (
                <button
                  key={`${mod.chainId}-${mod.address}`}
                  className="mod-option"
                  onClick={() => onSelect({ chainId: mod.chainId, rolesMod: mod.address })}
                >
                  <span>
                    <b>{shortHex(mod.address, 12, 10)}</b>
                    <small>
                      {chainName(mod.chainId)} ·{" "}
                      {!sameChain
                        ? "different chain from this Safe — read-only"
                        : governed
                          ? "owned by and acting on this Safe"
                          : "not fully governed by this Safe — read-only"}
                    </small>
                  </span>
                  <span className={`health-badge ${governed && sameChain ? "" : "warn"}`}>
                    {governed && sameChain ? "governed" : "view"}
                  </span>
                </button>
              );
            })}
            {!modsLoading && mods.length === 0 && (
              <div className="empty-state compact">
                <h3>No Roles modifier yet</h3>
                <p>
                  This Safe has no Roles modifier on any indexed chain. Deploy one to start
                  describing what each role may do.
                </p>
                {onSetUp && (
                  <button className="button primary" onClick={onSetUp}>
                    Deploy a Roles modifier
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="picker-actions">
            <button className="button ghost" onClick={() => setManual(true)}>
              Enter an address manually
            </button>
            {onSetUp && mods.length > 0 && (
              <button className="button ghost" onClick={onSetUp}>
                Deploy another modifier
              </button>
            )}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="app-shell boot">
      <div className="boot-card wide">
        <span className="brand-mark" aria-hidden="true">SR</span>
        <h1>Open a Roles modifier</h1>
        <p>
          {safe.mode === "safe-app"
            ? "Enter the modifier address to manage."
            : "Inspect any modifier's live policy and plan a diff. To submit changes, connect a Safe-aware wallet with the owning Safe selected, or open SafeRoles as a Safe App."}
        </p>
        <ScopeForm onSelect={onSelect} />
        {safe.mode === "safe-app" && (
          <button className="button ghost" onClick={() => setManual(false)}>
            Back to discovered modifiers
          </button>
        )}
      </div>
    </main>
  );
}

function ScopeForm({
  initial,
  onSelect,
}: {
  initial?: Scope;
  onSelect: (scope: Scope) => void;
}) {
  const [chainId, setChainId] = useState(initial?.chainId ?? 1);
  const [address, setAddress] = useState(initial?.rolesMod ?? "");
  const valid = isAddress(address);

  return (
    <div className="connection-fields">
      <label className="modal-field">
        <span>Chain</span>
        <select value={chainId} onChange={(event) => setChainId(Number(event.target.value))}>
          {supportedChainIds.map((id) => (
            <option key={id} value={id}>
              {chainName(id)}
            </option>
          ))}
        </select>
      </label>
      <label className="modal-field">
        <span>Roles modifier address</span>
        <input
          className="mono-input"
          value={address}
          placeholder="0x…"
          onChange={(event) => setAddress(event.target.value.trim())}
          onKeyDown={(event) => {
            if (event.key === "Enter" && valid) onSelect({ chainId, rolesMod: address });
          }}
        />
        {address && !valid && (
          <small className="error-text">Enter a complete 20-byte address.</small>
        )}
      </label>
      <button
        className="button primary"
        disabled={!valid}
        onClick={() => onSelect({ chainId, rolesMod: address })}
      >
        Read policy
      </button>
    </div>
  );
}

function DraftsDialog({
  drafts,
  activeDraftId,
  currentBaseHash,
  canSave,
  onSave,
  onClose,
  onOpen,
}: {
  drafts: ReturnType<typeof useDrafts>;
  activeDraftId: string | null;
  currentBaseHash: string | null;
  canSave: boolean;
  onSave: (name: string) => Promise<void>;
  onClose: () => void;
  onOpen: (summary: DraftSummary) => Promise<void>;
}) {
  const [name, setName] = useState("Policy update");
  useDismissOnEscape(onClose);
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="modal connection-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drafts-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">Saved work</span>
            <h2 id="drafts-title">Drafts</h2>
            <p>Scoped to this modifier. Loading one replaces the current edits.</p>
          </div>
          <button className="icon-button" aria-label="Close" onClick={onClose}>×</button>
        </div>
        {drafts.error && <p className="error-text">{drafts.error}</p>}
        {canSave && (
          <label className="modal-field">
            <span>Save current edits as</span>
            <div className="adopt-row">
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Draft name"
                onKeyDown={(event) => {
                  if (event.key === "Enter" && name.trim()) void onSave(name.trim());
                }}
              />
              <button
                className="button primary"
                disabled={!name.trim() || drafts.busy}
                onClick={() => void onSave(name.trim())}
              >
                Save
              </button>
            </div>
          </label>
        )}
        <div className="mod-list">
          {drafts.drafts.map((summary) => {
            const stale =
              Boolean(summary.baseStateHash && currentBaseHash) &&
              summary.baseStateHash !== currentBaseHash;
            return (
              <div className="draft-row" key={summary.id}>
                <span>
                  <b>
                    {summary.name}
                    {summary.id === activeDraftId ? " · open" : ""}
                  </b>
                  <small>
                    {new Date(summary.updatedAt).toLocaleString()}
                    {summary.createdBy ? ` · ${shortHex(summary.createdBy)}` : ""}
                    {stale ? " · based on older state" : ""}
                  </small>
                </span>
                <span className="draft-actions">
                  <button className="button secondary" onClick={() => void onOpen(summary)}>
                    Open
                  </button>
                  <button
                    className="row-remove"
                    aria-label={`Delete ${summary.name}`}
                    onClick={() => void drafts.remove(summary.id)}
                  >
                    ×
                  </button>
                </span>
              </div>
            );
          })}
          {drafts.drafts.length === 0 && (
            <p className="inline-empty">
              No drafts yet. Use “Save as draft” once you have changes.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

function ScopeDialog({
  initial,
  onClose,
  onSelect,
  onSetUp,
}: {
  initial: Scope;
  onClose: () => void;
  onSelect: (scope: Scope) => void;
  onSetUp?: () => void;
}) {
  useDismissOnEscape(onClose);
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="modal connection-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="scope-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">Scope</span>
            <h2 id="scope-title">Open a different modifier</h2>
          </div>
          <button className="icon-button" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <ScopeForm initial={initial} onSelect={onSelect} />
        {onSetUp && (
          <button className="button ghost" onClick={onSetUp}>
            Deploy a new Roles modifier instead
          </button>
        )}
      </section>
    </div>
  );
}

/* ========================================================================== */
/*                              Review & propose                              */
/* ========================================================================== */

function ReviewDialog({
  plan,
  draft,
  scope,
  safe,
  wallet,
  submitVia,
  verification,
  canSubmit,
  onClose,
  onSubmitted,
}: {
  plan: ReturnType<typeof usePolicy>["plan"];
  draft: DraftPolicy;
  scope: Scope;
  safe: ReturnType<typeof useSafe>;
  wallet: ReturnType<typeof useWallet>;
  submitVia: "safe-app" | "wallet" | "none";
  verification: { ok: boolean; problems: string[] };
  canSubmit: boolean;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [state, setState] = useState<"idle" | "submitting" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);

  const critical = plan.risk === "Critical";
  const submitter = submitVia === "wallet" ? wallet.account : safe.info?.safeAddress;
  // Not dismissable mid-submission: the wallet may already be applying calls.
  useDismissOnEscape(state === "submitting" ? () => {} : onClose);

  async function submit() {
    setState("submitting");
    setMessage(null);
    const payload = plan.transactions.map((transaction) => ({
      to: transaction.to,
      value: transaction.value,
      data: transaction.data,
    }));

    try {
      const id =
        submitVia === "wallet" ? await wallet.send(payload) : await safe.propose(payload);
      setReference(id);
      setState("done");

      // Record the reviewed diff. Best-effort: the transaction is already
      // submitted, so a storage failure must not read as a submission failure.
      try {
        await fetch("/api/proposals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chainId: scope.chainId,
            rolesMod: scope.rolesMod,
            safeAddress: submitter,
            safeTxHash: id,
            risk: plan.risk,
            calls: plan.calls,
            proposedBy: submitter,
          }),
        });
      } catch {
        setMessage("Submitted, but the local history record could not be saved.");
      }
      onSubmitted();
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Nothing was submitted.");
    }
  }

  function exportPolicy() {
    const payload = {
      schema: "saferoles/policy@2",
      chainId: scope.chainId,
      rolesMod: scope.rolesMod,
      generatedAt: new Date().toISOString(),
      policy: draft,
      plannedCalls: plan.calls,
    };
    const blob = new Blob(
      [
        JSON.stringify(
          payload,
          (_key, value) => (typeof value === "bigint" ? value.toString() : value),
          2,
        ),
      ],
      { type: "application/json" },
    );
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `roles-policy-${scope.rolesMod.slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(href);
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="modal review-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-title"
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">Pre-flight review</span>
            <h2 id="review-title">Planned changes</h2>
            <p>
              Diffed against the modifier&apos;s live configuration. This is exactly what will
              be proposed.
            </p>
          </div>
          <button className="icon-button" aria-label="Close" onClick={onClose}>×</button>
        </div>

        <div className="review-summary">
          <div>
            <span>Onchain calls</span>
            <strong>{plan.transactions.length}</strong>
          </div>
          <div>
            <span>Roles touched</span>
            <strong>{new Set(plan.changes.map((change) => change.scope)).size}</strong>
          </div>
          <div>
            <span>Highest risk</span>
            <strong className={`risk-text ${plan.risk.toLowerCase()}`}>{plan.risk}</strong>
          </div>
          <div>
            <span>Problems</span>
            <strong className={plan.issues.length ? "risk-text high" : ""}>
              {plan.issues.length}
            </strong>
          </div>
        </div>

        {plan.issues.length > 0 && (
          <div className="validation-issues" role="alert">
            <b>Fix these before a diff can be computed</b>
            <p className="issues-note">
              While any value is invalid its role cannot be encoded, and an unencodable role
              would look like a request to revoke everything in it. Nothing is planned until
              these are resolved.
            </p>
            <ul>
              {plan.issues.map((issue, index) => (
                <li key={`${issue.message}-${index}`}>{issue.message}</li>
              ))}
            </ul>
          </div>
        )}

        {plan.issues.length === 0 && (
          <div className="review-list">
            {plan.changes.map((change) => (
              <div className="review-row" key={change.id}>
                <span
                  className={`change-glyph ${
                    change.action === "Revoke" ? "removed" : change.action === "Grant" ? "added" : "updated"
                  }`}
                >
                  {change.action === "Revoke" ? "−" : change.action === "Grant" ? "+" : "~"}
                </span>
                <span>
                  <b>{change.summary}</b>
                  <small>
                    {change.scope} · {change.detail}
                  </small>
                  {change.rationale && <small className="rationale">{change.rationale}</small>}
                </span>
                <span className={`risk-badge ${change.risk.toLowerCase()}`}>{change.risk}</span>
              </div>
            ))}
            {plan.changes.length === 0 && (
              <p className="inline-empty">
                The draft matches the live configuration. Nothing to propose.
              </p>
            )}
          </div>
        )}

        {critical && (
          <div className="guardrail-callout critical">
            <b>Critical change blocked</b>
            <p>
              This batch enables delegatecall, which lets the target run code against the
              Safe&apos;s own storage and balances. Remove it, or configure it in the Zodiac
              Roles app where that risk is presented in full.
            </p>
          </div>
        )}

        {!verification.ok && (
          <div className="validation-issues" role="alert">
            <b>This Safe cannot govern this modifier</b>
            <ul>
              {verification.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        )}

        {submitVia === "safe-app" && safe.info?.isReadOnly && (
          <div className="banner info">
            <b>Read-only Safe session</b>
            <p>The Safe UI reports no signer, so a proposal cannot be submitted.</p>
          </div>
        )}

        {submitVia === "wallet" && wallet.batchSupport === "sequential" && (
          <div className="guardrail-callout medium">
            <b>
              {plan.transactions.length} separate confirmation
              {plan.transactions.length === 1 ? "" : "s"}
            </b>
            <p>
              This wallet cannot submit an atomic batch, so each call is confirmed and
              applied on its own. Stopping partway leaves the policy partially updated.
            </p>
          </div>
        )}

        {state === "done" && reference && (
          <div className="proposal-success">
            <span>✓</span>
            <p>
              <b>
                {submitVia === "wallet"
                  ? "Submitted through your wallet"
                  : "Queued in the Safe"}
              </b>
              <code>{shortHex(reference, 14, 12)}</code>
            </p>
            {submitter && safeTransactionUrl(scope.chainId, submitter, reference) && (
              <a
                className="button secondary"
                href={safeTransactionUrl(scope.chainId, submitter, reference) ?? "#"}
                target="_blank"
                rel="noreferrer"
              >
                View in Safe ↗
              </a>
            )}
          </div>
        )}

        {message && (
          <div className={state === "error" ? "connection-error" : "banner info"} role="alert">
            <b>{state === "error" ? "Not submitted" : "Note"}</b>
            <p>{message}</p>
          </div>
        )}

        <div className="modal-actions">
          <button onClick={onClose}>Back to editing</button>
          <button className="button secondary" onClick={exportPolicy}>
            Export JSON
          </button>
          <button
            className="button primary"
            onClick={submit}
            disabled={!canSubmit || critical || state === "submitting" || state === "done"}
          >
            {state === "submitting"
              ? "Submitting…"
              : state === "done"
                ? "Submitted"
                : submitVia === "none"
                  ? "Connect a wallet or open in Safe"
                  : `${submitVia === "wallet" ? "Submit" : "Propose"} ${plan.transactions.length} call${plan.transactions.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </section>
    </div>
  );
}
