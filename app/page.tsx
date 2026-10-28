import { ApiKeySettings } from "./components/api-key-settings";


import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { isAddress } from "ethers";
import { chainName, isSupportedChain } from "./lib/chains";
import { parseSignature, shortHex } from "./lib/abi";
import {
  conditionOperatorLabels,
  type DraftPermission,
} from "./lib/policy";
import { PermissionInspector } from "./permission-inspector";
import { draftPermissionRisk, highestRisk, riskReason } from "./lib/policy-plan";
import { useDiscoveredMods, usePolicy, type Scope } from "./lib/use-policy";
import { useSafe } from "./lib/use-safe";
import { useWallet } from "./lib/use-wallet";
import { useDrafts } from "./lib/use-drafts";
import { usePolicyEditor, tabs } from "./lib/use-policy-editor";
import { useSubmissionContext } from "./lib/use-submission-context";
import { isRecoveredPolicyStale } from "./lib/form-drafts";
import { WalletControl } from "./components/wallet-control";
import { ActivityPanel } from "./components/activity-panel";
import { AllowanceEditor } from "./components/allowance-editor";
import { DraftsDialog } from "./components/drafts-dialog";
import { ScopePicker } from "./components/scope-picker";
import { ContractName } from "./components/contract-name";
import { summarizeCondition } from "./lib/condition-summary";
import { isBlankPermission } from "./lib/policy-codec";
import type { DraftPolicy } from "./lib/policy";

const SetupPage = lazy(() => import("./setup-page").then(module => ({default:module.SetupPage})));
const ReviewPage = lazy(() => import("./review-page").then(module => ({default:module.ReviewPage})));

function initials(value: string): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "··";
  const letters = words.map((word) => word[0]).join("");
  // A single-word label (or a bare address) should still yield two characters.
  return (letters.length > 1 ? letters : words[0].slice(0, 2)).slice(0, 2).toUpperCase();
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
  const { tab, setTab, setSelectedRoleId, newRoleName, setNewRoleName, newMemberAddress, setNewMemberAddress, newMemberLabel, setNewMemberLabel, draft, roles, selectorNames, functionNames, selectedRole, selectedPermission, editRole, editPermission, addRole, addPermission, addMember, addAllowance, editAllowance, setSelectedPermissionId, resetSelection } = usePolicyEditor(policy);

  const [query, setQuery] = useState("");
  // The draft right after a removal, so Undo is offered only until the next edit.
  const [undo, setUndo] = useState<{ label: string; before: DraftPolicy; after: DraftPolicy } | null>(null);
  const [showScope, setShowScope] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [showDrafts, setShowDrafts] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  // Kept after setup so the dialog can confirm the address rather than vanishing.
  const [deployedModifier, setDeployedModifier] = useState<string | null>(null);
  const [showNewRole, setShowNewRole] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftVersion, setDraftVersion] = useState<number | null>(null);
  const [staleBase, setStaleBase] = useState(false);
  const [baselineNotice, setBaselineNotice] = useState<
    "changed" | "indexer-pending" | "submitted" | null
  >(null);

  const { mods, loading: modsLoading, error: modsError } = useDiscoveredMods(
    safe.info?.safeAddress ?? (wallet.safeInspection.status === "valid" ? wallet.account : null),
    safe.info?.chainId ?? wallet.chainId,
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
      setDraftVersion(null);
      setStaleBase(false);
      setBaselineNotice(null);
      setDeployedModifier(null);
      resetSelection();
      const url=new URL(window.location.href);
      url.searchParams.set("chainId",String(scope.chainId));url.searchParams.set("rolesMod",scope.rolesMod);
      window.history.replaceState(null,"",url);
      void loadPolicy(scope);
    },
    [loadPolicy, resetSelection],
  );

  useEffect(()=>{
    const params=new URLSearchParams(window.location.search);
    const chainId=Number(params.get("chainId")),rolesMod=params.get("rolesMod");
    if(!isSupportedChain(chainId) || !rolesMod || !isAddress(rolesMod))return;
    const timer=setTimeout(()=>openScope({chainId,rolesMod}),0);
    return()=>clearTimeout(timer);
  },[openScope]);

  // Recovered edits were saved against whatever snapshot was indexed then.
  // Say so explicitly rather than letting the rebuilt diff look fresh.
  const recoveredCopy = policy.recovered;
  const recoveredStale = Boolean(
    recoveredCopy && isRecoveredPolicyStale(recoveredCopy, policy.baseHash),
  );

  const saveDraft = useCallback(
    async (
      existingId: string | null,
      existingVersion: number | null,
      name = "Policy update",
    ) => {
      if (!policy.draft || !policy.scope) return;
      const saved = await drafts.save({
        name,
        policy: policy.draft,
        safeAddress:
          safe.info?.safeAddress ?? policy.facts?.avatar ?? policy.scope.rolesMod,
        baseStateHash: policy.baseHash,
        draftId: existingId,
        draftVersion: existingVersion,
      });
      setDraftId(saved.id);
      setDraftVersion(saved.version);
      return saved.id;
    },
    [drafts, policy.baseHash, policy.draft, policy.facts, policy.scope, safe.info],
  );

  /* ------------------------------- verification -------------------------- */

  const { submitVia, verification, setupSafeAddress, setupChainId, setupSubmitter } = useSubmissionContext(safe, wallet, policy);

  const plan = policy.plan;
  const blockingIssues = plan.issues;
  const canSubmit =
    submitVia !== "none" &&
    !policy.unindexed &&
    verification.ok &&
    !(submitVia === "safe-app" && safe.info?.isReadOnly) &&
    blockingIssues.length === 0 &&
    plan.transactions.length > 0;

  if(showSetup && setupSafeAddress && setupChainId!==null) return <Suspense fallback={<main className="configuration-content">Loading setup…</main>}><SetupPage
    key={`${setupChainId}:${setupSafeAddress}`} chainId={setupChainId} safeAddress={setupSafeAddress} submitter={setupSubmitter} wallet={safe.mode!=="safe-app"?wallet:null}
    onClose={()=>setShowSetup(false)} onDone={setDeployedModifier}
    onOpen={address=>{setShowSetup(false);openScope({chainId:setupChainId,rolesMod:address});}}
  /></Suspense>;
  if(showReview && policy.facts && policy.scope && draft) return <Suspense fallback={<p>Loading review…</p>}><ReviewPage
          plan={plan}
          draft={draft}
          draftId={draftId}
          scope={policy.scope}
          facts={policy.facts}
          safe={safe}
          wallet={wallet}
          submitVia={submitVia}
          verification={verification}
          canSubmit={canSubmit}
          recheckBaseline={policy.recheckBaseline}
          markSubmitted={policy.markSubmitted}
          onClose={() => setShowReview(false)}
          onFixIssue={(issue) => {
            setShowReview(false);
            setTab("Permissions");
            if (issue.roleId) setSelectedRoleId(issue.roleId);
            setSelectedPermissionId(issue.permissionId ?? null);
          }}
          onBaselineChanged={(reason) => {
            setShowReview(false);
            setBaselineNotice(reason);
          }}
          onSubmitted={() => setBaselineNotice("submitted")}
        /></Suspense>;

  if(showScope && policy.scope) return <ScopePicker safe={safe} wallet={wallet} mods={mods} modsLoading={modsLoading} modsError={modsError}
    onBack={()=>setShowScope(false)} onSelect={scope=>{setShowScope(false);openScope(scope);}}
    onSetUp={setupSafeAddress?()=>{setShowScope(false);setShowSetup(true);}:undefined}/>;

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

  if(!policy.scope) return <ScopePicker safe={safe} wallet={wallet} mods={mods} modsLoading={modsLoading} modsError={modsError} onSelect={openScope} onSetUp={setupSafeAddress?()=>setShowSetup(true):undefined}/>;

  if(policy.status==="loading" || policy.status==="idle") return <main className="app-shell boot"><div className="boot-card"><span className="brand-mark" aria-hidden="true">SR</span><h1>Reading policy</h1><p>{shortHex(policy.scope.rolesMod,10,8)} on {chainName(policy.scope.chainId)}</p></div></main>;

  if(policy.status==="error" || !draft) return <main className="app-shell boot"><div className="boot-card error"><h1>Could not read the policy</h1><p>{policy.error}</p><div className="boot-actions"><button className="button secondary" onClick={()=>void policy.reload()}>Try again</button><button className="button ghost" onClick={()=>setShowScope(true)}>Choose a different modifier</button></div></div></main>;

  /** Removes something from the draft and offers Undo until the next edit. */
  const removeWithUndo = (label: string, transform: (current: DraftPolicy) => DraftPolicy) => {
    const before = draft;
    const after = transform(before);
    policy.setDraft(() => after);
    setUndo({ label, before, after });
  };
  const removePermissionFromList = (roleId: string, permissionId: string, label: string) => {
    removeWithUndo(`permission ${label}`, (current) => ({
      ...current,
      roles: current.roles.map((role) => role.id === roleId ? { ...role, permissions: role.permissions.filter((item) => item.id !== permissionId) } : role),
    }));
    setSelectedPermissionId(null);
  };

  const memberDuplicate = Boolean(selectedRole && isAddress(newMemberAddress) && selectedRole.members.some((member) => member.address.toLowerCase() === newMemberAddress.toLowerCase()));
  const memberReady = isAddress(newMemberAddress) && !memberDuplicate;
  const filteredRoles=roles.filter(role=>`${role.name} ${role.key}`.toLowerCase().includes(query.toLowerCase()));
  return <main className="app-shell editor-page">
    <header className="topbar">
      <a className="brand" href="/" aria-label="SafeRoles home"><span className="brand-mark" aria-hidden="true">SR</span><span>SafeRoles</span></a>
      <button className="workspace-switcher" onClick={()=>setShowScope(true)}><span className="network-dot" aria-hidden="true"/><span><b>{chainName(policy.scope.chainId)}</b><small>Modifier · {shortHex(policy.scope.rolesMod)}</small></span><span aria-hidden="true">⌄</span></button>
      <div className="top-actions"><ApiKeySettings/>
        {safe.mode==="safe-app" && safe.info ? <span className="wallet-chip" title={safe.info.safeAddress}><span className="wallet-status-dot"/>{shortHex(safe.info.safeAddress)}<small>Safe App · {safe.info.threshold}/{safe.info.owners.length}</small></span>:<WalletControl wallet={wallet}/>}
        <button className="button ghost" onClick={()=>setShowDrafts(true)}>Drafts{drafts.drafts.length?` (${drafts.drafts.length})`:""}</button>
        <button className="button ghost" onClick={()=>void policy.reload()}>Refresh</button>
        <button className="button primary" onClick={()=>setShowReview(true)} disabled={plan.changes.length===0 && blockingIssues.length===0} title={plan.changes.length===0 && blockingIssues.length===0?"No changes to review yet":undefined}>{blockingIssues.length?`${blockingIssues.length} to fix`:plan.changes.length?`Review ${plan.changes.length} changes`:"Review"}</button>
      </div>
    </header>
    {!verification.ok && submitVia!=="none" && <div className="banner danger" role="alert"><b>This Safe cannot submit these changes</b><ul>{verification.problems.map(problem=><li key={problem}>{problem}</li>)}</ul>{submitVia==="wallet" && wallet.chainId!==policy.scope.chainId && <button className="button secondary" onClick={()=>void wallet.switchChain(policy.scope!.chainId)}>Switch wallet to {chainName(policy.scope.chainId)}</button>}</div>}

      {submitVia === "none" && (
        <div className="banner info compact" role="status">
          <b>View only</b>
          <span>
            Edits are saved here as a draft. To submit, connect a wallet with your Safe
            selected, or open SafeRoles inside Safe.
          </span>
          {wallet.error && <span className="error-text">{wallet.error}</span>}
        </div>
      )}

      {deployedModifier && (
        <div className="banner info">
          <b>A new Roles modifier is on its way</b>
          <p>
            Once the Safe transaction is executed, the modifier will be live at{" "}
            <code>{deployedModifier}</code>, with its first role configured.
            Submission is not execution; check the Safe queue before opening the indexed policy.
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

      {policy.unindexed && (
        <div className="banner danger" role="alert">
          <b>This modifier is not indexed yet</b>
          <p>
            It is deployed and enabled on your Safe, but the Roles indexer has not
            picked it up, so existing roles cannot be shown and changes cannot be
            submitted. Check again in a few minutes.
          </p>
          <div className="banner-actions">
            <button className="button secondary" onClick={() => void policy.reload()}>Check again</button>
          </div>
        </div>
      )}

      {policy.recovered && (
        <div className="banner info" role="status">
          <b>Restored unsaved edits from this browser</b>
          <p>
            Changes you had made but not saved as a draft were recovered
            automatically ({new Date(policy.recovered.savedAt).toLocaleString()}).
            They stay in this browser and are diffed against the current indexed
            policy; nothing has been submitted.
          </p>
          <div className="banner-actions">
            <button className="button secondary" onClick={policy.discard}>
              Discard recovered edits
            </button>
            <button className="button ghost" onClick={policy.dismissRecovered}>
              Keep editing
            </button>
          </div>
        </div>
      )}

      {(staleBase || recoveredStale) && (
        <div className="banner danger" role="alert">
          <b>This draft was based on an older configuration</b>
          <p>
            The modifier has changed since the draft was saved — another proposal has
            likely executed since. The diff is computed against the current indexed snapshot,
            so re-check it before submitting.
          </p>
        </div>
      )}

      {baselineNotice && (
        <div
          className={`banner ${
            baselineNotice === "submitted" ? "info" : "danger"
          }`}
          role="status"
        >
          <b>
            {baselineNotice === "changed"
              ? "Indexed policy changed — review rebuilt"
              : baselineNotice === "indexer-pending"
                ? "Waiting for the policy indexer"
                : "Submission accepted — waiting for indexed state"}
          </b>
          <p>
            {baselineNotice === "changed"
              ? "The indexed baseline changed after this review opened. No transaction was submitted. The diff now uses the newer snapshot; open review again and inspect the rebuilt calls."
              : "Another proposal was already submitted from this baseline. New submissions are blocked until the indexer observes the resulting policy, preventing a second diff from being built on stale state."}
          </p>
          <button
            className="button secondary"
            onClick={() => {
              setBaselineNotice(null);
              void policy.reload();
            }}
          >
            Refresh indexed state
          </button>
        </div>
      )}

      {submitVia === "wallet" && wallet.batchSupport === "sequential" && (
        <div className="banner info">
          <b>This wallet confirms each change separately</b>
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
              <span className="eyebrow">{plan.changes.length > 0 ? `Draft · ${plan.changes.length} unsaved change${plan.changes.length === 1 ? "" : "s"}` : "Indexed policy"}</span>
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
          {showNewRole && <form className="role-create-inline" onSubmit={event=>{event.preventDefault();if(newRoleName.trim()){addRole();setShowNewRole(false);}}}>
            <label className="modal-field"><span>New role name</span><input autoFocus value={newRoleName} onChange={event=>setNewRoleName(event.target.value)} placeholder="e.g. Treasury operations"/></label>
            <div><button type="button" className="button ghost" onClick={()=>setShowNewRole(false)}>Cancel</button><button className="button primary" disabled={!newRoleName.trim()}>Create role</button></div>
          </form>}
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
                      {role.permissions.filter((item) => !isBlankPermission(item)).length} permission
                      {role.permissions.filter((item) => !isBlankPermission(item)).length === 1 ? "" : "s"}
                    </small>
                  </span>
                  <span className={`risk-dot ${roleRisk.toLowerCase()}`} role="img" aria-label={`Highest permission risk: ${roleRisk}`} title={`Highest permission risk: ${roleRisk}`} />
                </button>
              );
            })}
            {roles.length > 0 && filteredRoles.length === 0 && (
              <p className="inline-empty">No role matches “{query}”.</p>
            )}
            {roles.length === 0 && (
              <p className="inline-empty">
                This modifier has no roles yet.
              </p>
            )}
          </div>
          <div className="sidebar-foot">
            <span>Modifier</span>
            <code title={policy.scope.rolesMod}>{shortHex(policy.scope.rolesMod, 10, 8)}</code>
            {/* No badge without a submitter: the view-only notice already says so. */}
            {submitVia !== "none" && (
              <span className={`health-badge ${verification.ok ? "" : "warn"}`}>
                {verification.ok ? "Can submit" : "Cannot submit here"}
              </span>
            )}
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
                      readOnly={Boolean(selectedRole.deployedKey)}
                      placeholder="role_key"
                      onChange={(event) =>
                        editRole(selectedRole.id, (role) => ({
                          ...role,
                          key: event.target.value,
                        }))
                      }
                    />
                    <small>
                      {selectedRole.deployedKey
                        ? "Deployed role keys are locked. The name and description can be edited without changing the key."
                        : "The role’s on-chain identity. Choose a unique key before applying this role; it will be locked once deployed."}
                    </small>
                  </label>
                </div>
                <button
                  className="delete-link"
                  title={selectedRole.deployedKey ? "Revokes all of this role's permissions and members on chain once submitted. You can undo until your next edit." : "Removes this unsaved role"}
                  onClick={() => {
                    removeWithUndo(`role ${selectedRole.name || selectedRole.key}`, (current) => ({ ...current, roles: current.roles.filter((entry) => entry.id !== selectedRole.id) }));
                    setSelectedRoleId(null);
                    setSelectedPermissionId(null);
                  }}
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
                <div className="content-grid permission-workspace">
                  {!selectedPermission && <section className="content-panel">
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
                            <div className="permission-row-wrap" key={permission.id}>
                            <button
                              className="permission-row"
                              onClick={() => setSelectedPermissionId(permission.id)}
                            >
                              <span className="target-cell">
                                <span className="contract-mark" aria-hidden="true">
                                  {permissionGlyph(permission)}
                                </span>
                                <span>
                                  <b><ContractName chainId={policy.scope!.chainId} address={permission.targetAddress} label={permission.name}/></b>
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
                                  (() => {
                                    const lines = summarizeCondition(permission.rawCondition);
                                    return lines.length ? (
                                      <>
                                        {lines.slice(0, 2).map((line) => (
                                          <span className="condition-chip locked" key={line} title="Deployed condition, preserved exactly as on chain">{line}</span>
                                        ))}
                                        {lines.length > 2 && <span className="condition-chip neutral">+{lines.length - 2} more</span>}
                                      </>
                                    ) : (
                                      <span className="condition-chip locked">Deployed condition</span>
                                    );
                                  })()
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
                              <span className={`risk-badge ${risk.toLowerCase()}`} title={riskReason(permission)}>{risk}</span>
                            </button>
                            <button
                              className="row-remove permission-remove"
                              aria-label={`Remove permission ${permission.name || shortHex(permission.targetAddress) || "New target"}`}
                              title="Remove permission"
                              onClick={() => removePermissionFromList(selectedRole.id, permission.id, permission.name || shortHex(permission.targetAddress) || "(new)")}
                            >
                              ×
                            </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>}

                  {selectedPermission && <section className="inspector permission-detail">
                    <button className="button ghost permission-back" onClick={()=>setSelectedPermissionId(null)}>← All permissions</button>
                    
                      <PermissionInspector
                        key={selectedPermission.id}
                        permission={selectedPermission}
                        allowances={draft.allowances}
                        chainId={policy.scope.chainId}
                        selectorNames={selectorNames}
                        onChange={(update) =>
                          editPermission(selectedRole.id, selectedPermission.id, update)
                        }
                        onRemove={() => removePermissionFromList(selectedRole.id, selectedPermission.id, selectedPermission.name || shortHex(selectedPermission.targetAddress) || "(new)")}
                      />
                  </section>}
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
                      onKeyDown={(event) => { if (event.key === "Enter" && memberReady) addMember(); }}
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
                      disabled={!memberReady}
                    >
                      Add member
                    </button>
                  </div>
                  {newMemberAddress && !isAddress(newMemberAddress) && (
                    <small className="error-text">Enter a complete 20-byte address.</small>
                  )}
                  {memberDuplicate && (
                    <small className="error-text">This address is already a member of this role.</small>
                  )}
                  <div className="member-table">
                    <div className="table-head">
                      <span>Member &amp; label</span>
                      <span>Address</span>
                      <span />
                    </div>
                    {selectedRole.members.map((member) => (
                      <div className="member-row" key={member.id}>
                        <span className="member-name">
                          <span className="avatar">{initials(member.label ?? member.address.slice(2, 4))}</span>
                          <input
                            className="member-label-input"
                            aria-label={`Label for ${shortHex(member.address)}`}
                            placeholder="Add a label (not stored on chain)"
                            value={member.label ?? ""}
                            onChange={(event) =>
                              editRole(selectedRole.id, (role) => ({
                                ...role,
                                members: role.members.map((item) => item.id === member.id ? { ...item, label: event.target.value || undefined } : item),
                              }))
                            }
                          />
                        </span>
                        <code title={member.address}>{shortHex(member.address, 10, 8)}</code>
                        <button
                          aria-label={`Remove member ${member.label || shortHex(member.address)}`}
                          onClick={() =>
                            removeWithUndo(`member ${member.label || shortHex(member.address)}`, (current) => ({
                              ...current,
                              roles: current.roles.map((role) => role.id === selectedRole.id ? { ...role, members: role.members.filter((item) => item.id !== member.id) } : role),
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
                  <details className="how-to" open={draft.allowances.length === 0}>
                    <summary>How allowances work</summary>
                    <p>
                      An allowance is a shared spending budget. It does nothing until a permission
                      points at it, and then every call by a member of that role spends from it.
                      When the budget runs out, further calls are denied until it refills.
                    </p>
                    <p><b>Example: let the bot move at most 1,000 USDC per day</b></p>
                    <ol>
                      <li>Add an allowance named <code>usdc_daily</code>. USDC has 6 decimals, so 1,000 USDC is <code>1000000000</code>. Set Available now, Ceiling and Refill amount to that, and the period to Daily.</li>
                      <li>Open the role&apos;s <code>transfer</code> permission on the USDC contract and add a condition on <b>value</b>: <b>Within allowance</b> → <code>usdc_daily</code>.</li>
                      <li>Review and submit. Allowances are shared by the whole modifier, so the same budget can cap several permissions or roles together.</li>
                    </ol>
                  </details>
                  <div className="allowance-list">
                    {draft.allowances.map((allowance) => (
                      <AllowanceEditor
                        key={allowance.id}
                        allowance={allowance}
                        usedBy={draft.roles.flatMap((role) =>
                          role.permissions
                            .filter((permission) => permission.conditions.some((condition) => condition.operator === "withinAllowance" && condition.value === allowance.key && allowance.key))
                            .map((permission) => `${role.name || role.key}: ${permission.name || permission.signatureLabel || permission.signature || shortHex(permission.targetAddress)}`),
                        )}
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
                        <h3>No allowances yet</h3>
                        <p>Add one to cap how much a role can spend over time, for example 1,000 USDC per day. Without one, a permission can only limit each single call.</p>
                        <button className="button secondary" onClick={addAllowance}>+ Add allowance</button>
                      </div>
                    )}
                  </div>
                </section>
              )}

              {tab === "Activity" && (
                <ActivityPanel
                  safe={safe}
                  chainId={policy.scope.chainId}
                  rolesMod={policy.scope.rolesMod}
                />
              )}
            </>
          ) : (
            <div className="empty-state">
              <span className="empty-mark" aria-hidden="true">∅</span>
              <h3>{plan.changes.length > 0 ? "All roles are removed in this draft" : "No roles on this modifier"}</h3>
              <p>{plan.changes.length > 0 ? "Submitting would revoke everything. Undo the removal or Discard edits to bring them back." : "Create a role to start describing what it may do."}</p>
              <button className="button primary" onClick={() => setShowNewRole(true)}>
                Create a role
              </button>
            </div>
          )}
        </section>
      </div>

      {undo && draft === undo.after && (
        <div className="undo-toast" role="status">
          <span>Removed {undo.label}.</span>
          <button onClick={() => { policy.setDraft(() => undo.before); setUndo(null); }}>Undo</button>
          <button aria-label="Dismiss" onClick={() => setUndo(null)}>×</button>
        </div>
      )}

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
                  <>
                    {blockingIssues[0]?.message}{" "}
                    {blockingIssues[0]?.roleId && (
                      <button
                        className="link-button"
                        onClick={() => {
                          const issue = blockingIssues[0]!;
                          setTab("Permissions");
                          setSelectedRoleId(issue.roleId!);
                          setSelectedPermissionId(issue.permissionId ?? null);
                        }}
                      >
                        Go fix this
                      </button>
                    )}
                  </>
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
            {policy.autosavedAt && (
              <span
                className="autosave-note"
                title={`Last autosaved ${new Date(policy.autosavedAt).toLocaleTimeString()}`}
              >
                Autosaved locally
              </span>
            )}
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
                  void saveDraft(draftId, draftVersion);
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


      {showDrafts && (
        <DraftsDialog
          policy={draft}
          safeAddress={safe.info?.safeAddress ?? policy.facts?.avatar ?? policy.scope.rolesMod}
          drafts={drafts}
          onDeleted={id=>{if(id===draftId){setDraftId(null);setDraftVersion(null);setStaleBase(false);}}}
          activeDraftId={draftId}
          currentBaseHash={policy.baseHash}
          canSave={policy.dirty || plan.changes.length > 0}
          onSave={async (name) => {
            await saveDraft(draftId, draftVersion, name);
            setShowDrafts(false);
          }}
          onClose={() => setShowDrafts(false)}
          onOpen={async (summary) => {
            const opened = await drafts.open(summary);
            policy.applyDraft(opened.policy);
            setDraftId(summary.id);
            setDraftVersion(opened.version);
            // A draft saved against a different baseline still shows a diff, but
            // against today's indexed snapshot — say so rather than imply it is fresh.
            setStaleBase(
              Boolean(
                opened.baseStateHash &&
                  policy.baseHash &&
                  opened.baseStateHash !== policy.baseHash,
              ),
            );
            resetSelection();
            setShowDrafts(false);
          }}
        />
      )}






    </main>
  ;
}
