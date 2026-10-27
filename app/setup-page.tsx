import { ConfigurationPage } from "./components/configuration-page";
import type { WalletState } from "./lib/use-wallet";
import { browserRolesReader, readBrowserAbi } from "./lib/browser-data";
/**
 * Atomic deployment, module enablement and first-role configuration.
 *
 * No `"use client"` directive: this renders inside the client console, and
 * marking it an entry would impose serializable-prop rules on its callbacks.
 *
 * Enabling a Safe module grants it authority to execute arbitrary transactions
 * from the Safe, bypassing the owner threshold. Every input is therefore verified
 * against the chain and the published source before a batch can be built, and the
 * consequence is stated plainly rather than buried.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isAddress } from "ethers";
import { PermissionInspector } from "./permission-inspector";
import { buildInitializationPlan, suggestRoleKey, verifyInitialization } from "./lib/initialization";
import type { DraftRole } from "./lib/policy";
import { shortHex } from "./lib/abi";
import { chainName } from "./lib/chains";
import type { ResolvedAbi } from "./lib/abi-source";
import {
  submissionReferences,
  type SubmissionResult,
} from "./lib/submission";
import {
  MODULE_PROXY_FACTORY,
  SUGGESTED_ROLES_MASTERCOPY,
  checksPass,
  evaluateMastercopy,
  freshSaltNonce,
  type SetupCheck,
} from "./lib/setup-roles";
import {
  clearSavedForm,
  formKeys,
  parseSetupFormState,
  readSavedForm,
  writeSavedForm,
  type SetupFormState,
} from "./lib/form-drafts";

export type SetupSubmitter = {
  /** Human-readable name of the route the batch will take. */
  label: string;
  submit: (
    transactions: { to: string; value: string; data: string }[],
  ) => Promise<SubmissionResult>;
  getCode: (address: string) => Promise<string | null>;
  chainId: number;
  readContract: (to: string, data: string) => Promise<string | null>;
  /** Setup must be deploy+enable as one indivisible Safe operation. */
  atomic: boolean;
  /** Why atomic batches are unavailable, shown next to the blocker. */
  atomicDetail?: string;
  /** True when the wallet will be asked for each call in turn (verified Safe only). */
  sequential?: boolean;
  /** The submitting address was positively identified as a Safe contract. */
  safeVerified: boolean;
};

type SetupPageProps = {
  chainId: number;
  safeAddress: string;
  /** Null when nothing can submit; the dialog then explains rather than offering. */
  submitter: SetupSubmitter | null;
  /** Pinned in the header so the account/network can be changed here. Null inside Safe. */
  wallet?: WalletState | null;
  onClose: () => void;
  onDone: (modifierAddress: string) => void;
  onOpen: (modifierAddress: string) => void;
};

const EMPTY_ROLE: DraftRole = {
  id: "first-role",
  key: "",
  name: "",
  description: "",
  members: [],
  permissions: [],
};

/**
 * Loads the autosaved form before mounting the editable form.
 *
 * Reading in an effect after mount would race with the first keystroke and could
 * replace what the user is already typing, so the form receives the recovered
 * values as its initial state instead.
 */
export function SetupPage(props: SetupPageProps) {
  const { chainId, safeAddress, onClose } = props;
  const key = formKeys.setup(chainId, safeAddress);
  const [restored, setRestored] = useState<
    { form: SetupFormState; savedAt: number } | null | undefined
  >(undefined);

  useEffect(() => {
    let cancelled = false;
    void readSavedForm(key, (value) =>
      parseSetupFormState(value, { chainId, safeAddress }),
    )
      .then((saved) => {
        if (cancelled) return;
        setRestored(saved ? { form: saved.data, savedAt: saved.savedAt } : null);
      })
      .catch(() => {
        if (!cancelled) setRestored(null);
      });
    return () => {
      cancelled = true;
    };
  }, [key, chainId, safeAddress]);

  if (restored === undefined) {
    return (
      <ConfigurationPage onBack={onClose} backLabel="Back to Safe" wallet={props.wallet} requiredChainId={chainId}>
        <section className="configuration-sheet">
          <p className="inline-empty">Restoring the setup form saved in this browser…</p>
        </section>
      </ConfigurationPage>
    );
  }

  return (
    <SetupForm
      {...props}
      initial={restored?.form ?? null}
      restoredAt={restored?.savedAt ?? null}
    />
  );
}

function SetupForm({
  chainId,
  safeAddress,
  submitter,
  wallet,
  onClose,
  onDone,
  onOpen,
  initial,
  restoredAt,
}: SetupPageProps & {
  initial: SetupFormState | null;
  restoredAt: number | null;
}) {
  const formKey = formKeys.setup(chainId, safeAddress);
  const [step, setStep] = useState<"role" | "review">(initial?.step ?? "role");
  const [showRoleIssues,setShowRoleIssues]=useState(false);
  const [checkAttempt,setCheckAttempt]=useState(0);
  const checksRef=useRef<HTMLDivElement|null>(null);
  const permissionButtonRef=useRef<HTMLButtonElement|null>(null);
  const roleIssuesRef=useRef<HTMLDivElement|null>(null);
  const [recovered, setRecovered] = useState(restoredAt !== null);
  function addPermission(){
    const id=crypto.randomUUID();
    setRole(current=>({...current,permissions:[...current.permissions,{id,name:"",targetAddress:"",mode:"function",signature:"",send:false,delegatecall:false,conditions:[]}]}));
    requestAnimationFrame(()=>{
      const panel=document.getElementById(`setup-permission-${id}`);
      panel?.scrollIntoView({block:"center",behavior:"smooth"});
      panel?.querySelector<HTMLInputElement>('input')?.focus({preventScroll:true});
    });
  }

  const [role, setRole] = useState<DraftRole>(initial?.role ?? EMPTY_ROLE);
  const [memberAddress, setMemberAddress] = useState(initial?.memberAddress ?? "");
  const [keyEdited, setKeyEdited] = useState(initial?.keyEdited ?? false);
  const [mastercopy] = useState(SUGGESTED_ROLES_MASTERCOPY);
  const [saltNonce, setSaltNonce] = useState(initial?.saltNonce ?? freshSaltNonce());
  const [factoryCode, setFactoryCode] = useState<string | null>(null);

  // Fetched values are tagged with the address they describe, and read back only
  // on a match. A result for a previously-typed address can therefore never be
  // shown as a passing check for the current one.
  const [codeFor, setCodeFor] = useState<{ address: string; code: string } | null>(null);
  const [predictedFor, setPredictedFor] = useState<{ address: string; code: string } | null>(
    null,
  );
  const [abiFor, setAbiFor] = useState<{ address: string; abi: ResolvedAbi | null } | null>(
    null,
  );
  const [state, setState] = useState<"idle" | "submitting" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [execution, setExecution] = useState<{ checking: boolean; message: string | null }>({ checking: false, message: null });
  const [submission, setSubmission] = useState<SubmissionResult | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const mounted = useRef(true);

  // The plan is derived, so the address shown is always the address that the
  // encoded batch will actually create.
  const plan = useMemo(() => {
    try {
      return buildInitializationPlan({ safeAddress, saltNonce, chainId, role });
    } catch {
      return null;
    }
  }, [safeAddress, saltNonce, chainId, role]);

  const readCode = submitter?.getCode;
  const matches = (a: string | undefined, b: string | undefined) =>
    Boolean(a && b && a.toLowerCase() === b.toLowerCase());

  const code = matches(codeFor?.address, mastercopy) ? codeFor!.code : null;
  const predictedCode = matches(predictedFor?.address, plan?.predictedAddress)
    ? predictedFor!.code
    : null;
  const abi = matches(abiFor?.address, mastercopy) ? abiFor!.abi : undefined;

  useEffect(() => {
    if (!isAddress(mastercopy) || !readCode) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const result = await readCode(mastercopy);
        if (!cancelled) {
          setCodeFor({
            address: mastercopy,
            code: result ?? "read-unavailable",
          });
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mastercopy, readCode, checkAttempt]);

  useEffect(() => {
    if (!readCode) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const result = await readCode(MODULE_PROXY_FACTORY);
        if (!cancelled) setFactoryCode(result ?? "read-unavailable");
      })();
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [readCode, checkAttempt]);

  useEffect(() => {
    if (!plan || !readCode) return;
    const target = plan.predictedAddress;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const result = await readCode(target);
        if (!cancelled) {
          setPredictedFor({
            address: target,
            code: result ?? "read-unavailable",
          });
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [plan, readCode, checkAttempt]);

  // Identity comes from the published source, not from the address matching a
  // constant in this app.
  useEffect(() => {
    if (!isAddress(mastercopy)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const resolved = await readBrowserAbi(chainId, mastercopy);
          if (!cancelled) {
            setAbiFor({
              address: mastercopy,
              abi: resolved,
            });
          }
        } catch {
          if (!cancelled) setAbiFor({ address: mastercopy, abi: null });
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [chainId, mastercopy, checkAttempt]);

  const checks: SetupCheck[] = useMemo(
    () =>
      evaluateMastercopy({
        mastercopy,
        // Unknown, not satisfied: with no provider the bytecode cannot be read,
        // and a placeholder string here read as "code is present" and showed a
        // passing check for a contract nobody had looked at.
        code: readCode ? code : null,
        abiName: abi === undefined ? null : (abi?.name ?? null),
        abiFunctions:
          abi === undefined ? null : (abi?.functions.map((entry) => entry.name) ?? []),
        abiSource: abi === undefined ? null : (abi?.source ?? null),
        factoryCode: readCode ? factoryCode : undefined,
        predictedCode: readCode ? predictedCode : undefined,
      }).map(check=>!readCode && (check.id==="deployed" || check.id==="runtime") ? {...check,detail:"Connect your Safe to run this check."}:check),
    [abi, code, factoryCode, mastercopy, predictedCode, readCode],
  );

  const ready = Boolean(
    plan &&
      plan.issues.length === 0 &&
      submitter &&
      submitter.chainId === chainId &&
      (submitter.atomic || submitter.sequential) &&
      submitter.safeVerified &&
      checksPass(checks),
  );

  const blockers:string[]=[];
  if(!plan)blockers.push("The role configuration could not be prepared.");
  else if(plan.issues.length)blockers.push(...plan.issues.map(issue=>issue.message));
  if(!submitter)blockers.push("Open this Safe in Safe, or connect a wallet with the Safe account selected.");
  else {
    if(submitter.chainId!==chainId)blockers.push(`Switch your wallet to ${chainName(chainId)}.`);
    if(!submitter.safeVerified)blockers.push("Select a verified Safe account in your wallet.");
    if(!submitter.atomic && !submitter.sequential)blockers.push(`This wallet cannot approve the complete setup together${submitter.atomicDetail?` — ${submitter.atomicDetail}`:""}. Open this app inside Safe to continue.`);
  }
  if(submitter)blockers.push(...checks.filter(check=>check.status!=="pass").map(check=>`${check.status==="pending"?"Waiting for":"Check failed"}: ${check.label}.`));
  function retryChecks(){setCodeFor(null);setFactoryCode(null);setPredictedFor(null);setAbiFor(null);setCheckAttempt(attempt=>attempt+1);}

  const submit = useCallback(async () => {
    if (!ready || !plan || !submitter || state === "submitting" || state === "done") return;
    setState("submitting");
    setMessage(null);
    try {
      const result = await submitter.submit(plan.transactions);
      setSubmission(result);
      setState("done");
      setRecovered(false);
      void clearSavedForm(formKey);
      onDone(plan.predictedAddress);
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Nothing was submitted.");
    }
  }, [onDone, plan, submitter, ready, state, formKey]);

  async function checkExecution() {
    if (!plan || !submitter || submitter.chainId !== chainId) return;
    setExecution({ checking: true, message: null });
    try {
      await verifyInitialization({ safeAddress, modifierAddress: plan.predictedAddress, getCode: submitter.getCode, readContract: submitter.readContract });
      // The editor needs the full indexed policy; do not invent a post-execution baseline.
      const mod = await browserRolesReader.read({chainId,address:plan.predictedAddress},{cache:"no-store"});
      if (!mod) throw new Error("Deployment is verified on chain. The policy indexer is still catching up; check again shortly.");
      if (mounted.current) onOpen(plan.predictedAddress);
    } catch (error) {
      if (!mounted.current) return;
      setExecution({ checking: false, message: error instanceof Error ? error.message : "Execution could not be verified." });
    }
  }

  useEffect(() => {
    mounted.current = true;
    window.scrollTo(0,0);
    dialogRef.current?.focus({preventScroll:true});
    return () => { mounted.current = false; };
  }, []);

  useEffect(()=>{window.scrollTo(0,0);},[step]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && state !== "submitting") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, state]);

  // Autosave this form so a reload, an accidental close or a wallet prompt that
  // navigates away does not discard the configuration. An untouched form keeps
  // no record, so it is never later presented as recovered work.
  const hasContent = Boolean(
    role.name ||
      role.key ||
      role.members.length ||
      role.permissions.length ||
      memberAddress ||
      step === "review",
  );
  useEffect(() => {
    if (state === "done" || state === "submitting") return;
    if (!hasContent) {
      void clearSavedForm(formKey);
      return;
    }
    const value: SetupFormState = { role, memberAddress, keyEdited, saltNonce, step };
    const timer = window.setTimeout(() => {
      void writeSavedForm(formKey, value).catch(() => {});
    }, 500);
    const flush = () => {
      void writeSavedForm(formKey, value).catch(() => {});
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pagehide", flush);
    };
  }, [formKey, role, memberAddress, keyEdited, saltNonce, step, state, hasContent]);

  function discardRecoveredForm() {
    setRole(EMPTY_ROLE);
    setMemberAddress("");
    setKeyEdited(false);
    setSaltNonce(freshSaltNonce());
    setStep("role");
    setShowRoleIssues(false);
    setRecovered(false);
    void clearSavedForm(formKey);
  }

  return (
    <ConfigurationPage onBack={onClose} backLabel="Back to Safe" busy={state === "submitting"} wallet={wallet} requiredChainId={chainId}>
      <section
        ref={dialogRef}
        className="configuration-sheet setup-page"
        aria-labelledby="setup-title"
        tabIndex={-1}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">First-time setup</span>
            <h1 id="setup-title">Set up role permissions</h1>
            <p>
              {shortHex(safeAddress)} · {chainName(chainId)}. Configure the first role,
              then review and approve the complete setup together.
            </p>
          </div>

        </div>

        {recovered && restoredAt !== null && state !== "done" && (
          <div className="banner info" role="status">
            <b>Restored your unfinished setup from this browser</b>
            <p>
              Saved {new Date(restoredAt).toLocaleString()}. Nothing has been
              submitted; review every field before approving.
            </p>
            <div className="banner-actions">
              <button className="button secondary" onClick={discardRecoveredForm}>
                Discard and start over
              </button>
              <button className="button ghost" onClick={() => setRecovered(false)}>
                Keep editing
              </button>
            </div>
          </div>
        )}

        <ol className="setup-steps" aria-label="Initialization progress">
          <li aria-current={step === "role" ? "step" : undefined}>1. Role details</li>
          <li aria-current={step === "review" && state !== "done" ? "step" : undefined}>2. Review setup</li>
          <li aria-current={state === "done" ? "step" : undefined}>3. Await execution</li>
        </ol>

        {step === "role" && (
          <div className="setup-role-editor">
            <div className="field-grid">
              <label><span>Role name</span><input value={role.name} placeholder="e.g. Treasury operations" onChange={event => {
                const name = event.target.value;
                setRole(current => ({ ...current, name, key: keyEdited ? current.key : suggestRoleKey(name) }));
              }} /></label>
              <label><span>Role key</span><input className="mono-input" value={role.key} onChange={event => {
                setKeyEdited(true);
                setRole(current => ({ ...current, key: event.target.value }));
              }} /><small>On-chain identity. Locked after deployment.</small></label>
            </div>
            <div className="section-label"><div><b>Members</b><span>Addresses allowed to use this role</span></div></div>
            <div className="adopt-row">
              <input aria-label="First role member" className="mono-input" placeholder="0x…" value={memberAddress} onChange={event => setMemberAddress(event.target.value.trim())} />
              <button className="button secondary" disabled={!isAddress(memberAddress) || role.members.some(m => m.address.toLowerCase() === memberAddress.toLowerCase())} onClick={() => {
                setRole(current => ({ ...current, members: [...current.members, { id: crypto.randomUUID(), address: memberAddress }] }));
                setMemberAddress("");
              }}>Add member</button>
            </div>
            {role.members.map(member => <div className="setup-member" key={member.id}>
              <code>{member.address}</code><button aria-label={`Remove member ${member.address}`} onClick={() => setRole(current => ({ ...current, members: current.members.filter(m => m.id !== member.id) }))}>Remove</button>
            </div>)}
            <div className="section-label"><div><b>Permissions</b><span>Only the calls configured here will be allowed</span></div>
              {role.permissions.length>0 && <button type="button" className="button secondary" onClick={addPermission}>Add permission</button>}
            </div>
            {role.permissions.length===0 && <div className="setup-permission-empty">
              <div><h3>Add the first permission</h3><p>Choose a contract and the function this role may call. A member alone cannot execute any actions.</p></div>
              <button ref={permissionButtonRef} type="button" className="button secondary" onClick={addPermission}>Add permission</button>
            </div>}
            {role.permissions.map(permission => <div className="setup-permission" id={`setup-permission-${permission.id}`} key={permission.id}>
              <PermissionInspector permission={permission} allowances={[]} chainId={chainId} selectorNames={{}}
                onChange={update => setRole(current => ({ ...current, permissions: current.permissions.map(p => p.id === permission.id ? update(p) : p) }))}
                onRemove={() => setRole(current => ({ ...current, permissions: current.permissions.filter(p => p.id !== permission.id) }))} />
            </div>)}
            <p className="inline-empty">Changes stay local until you approve setup. Nothing changes on chain while you edit.</p>
            {showRoleIssues && (!plan || plan.issues.length>0) && <div ref={roleIssuesRef} className="connection-error" role="alert" tabIndex={-1}>
              <b>Complete the first role before continuing</b>
              <ul className="setup-issues">{plan ? plan.issues.map((issue,index)=><li key={index}>{issue.message}</li>) : <li>Check the role details. The initialization could not be prepared.</li>}</ul>
            </div>}
          </div>
        )}

        {step === "review" && <>
        <div className="guardrail-callout critical">
          <b>Enabling a module grants execution authority</b>
          <p>
            An enabled module can execute transactions from this Safe without owner
            signatures. That is what makes a Roles modifier useful — it enforces the
            policy instead — but it means the contract being enabled must be the right
            one. Every check below has to pass before this can be submitted.
          </p>
        </div>

        <label className="modal-field">
          <span>Roles mastercopy</span>
          <input
            className="mono-input"
            value={mastercopy}
            readOnly
            placeholder="0x…"
          />
          <small>
            Setup is pinned to the approved Roles implementation. Its exact deployed
            runtime and the factory runtime are verified below before submission.
          </small>
        </label>

        <div className="check-list" ref={checksRef}>
          {checks.map((check) => (
            <div className={`check-row ${check.status}`} key={check.id}>
              <span className="check-mark" aria-hidden="true">
                {check.status === "pass" ? "✓" : check.status === "fail" ? "✕" : "…"}
              </span>
              <span>
                <b>{check.label}</b>
                <small>{check.detail}</small>
              </span>
            </div>
          ))}
          {!readCode && (
            <div className="check-row fail">
              <span className="check-mark" aria-hidden="true">
                ✕
              </span>
              <span>
                <b>On-chain checks unavailable</b>
                <small>
                  Connect a wallet or open SafeRoles as a Safe App so the mastercopy,
                  factory and target address can be read from the chain.
                </small>
              </span>
            </div>
          )}
        </div>

        {submitter && submitter.chainId !== chainId && (
          <div className="validation-issues" role="alert">
            <b>Wrong network</b>
            <p>
              The submitter is on {chainName(submitter.chainId)}, while this setup
              targets {chainName(chainId)}.
            </p>
          </div>
        )}

        {submitter && !submitter.safeVerified && (
          <div className="validation-issues" role="alert">
            <b>Submitting account is not a verified Safe</b>
            <p>Select your Safe account rather than a personal wallet account.</p>
          </div>
        )}

        {submitter && !submitter.atomic && submitter.sequential && submitter.safeVerified && (
          <div className="guardrail-callout" role="status">
            <b>Your wallet will ask twice</b>
            <p>
              This wallet cannot batch calls, so it will first deploy the modifier
              and then enable it on your Safe. Enabling comes last: if the second
              step is cancelled or fails, the Safe is unchanged and only an unused
              modifier exists. Confirm both requests (each may need Safe owner
              signatures) and use Retry checks if anything looks off.
            </p>
          </div>
        )}

        {submitter && !submitter.atomic && !submitter.safeVerified && (
          <div className="guardrail-callout critical" role="alert">
            <b>Atomic setup is required</b>
            <p>
              Without a verified Safe account, deploying and enabling must be
              submitted as one Safe batch, so this path is blocked.
            </p>
          </div>
        )}

        {plan && (
          <>
            <div className="review-summary">
              <div>
                <span>Modifier address</span>
                <strong className="mono-strong">{shortHex(plan.predictedAddress, 10, 8)}</strong>
              </div>
              <div>
                <span>Owner, avatar &amp; target</span>
                <strong className="mono-strong">{shortHex(safeAddress)}</strong>
              </div>
              <div>
                <span>Salt</span>
                <strong className="mono-strong">{plan.saltNonce}</strong>
              </div>
              <div>
                <span>Calls</span>
                <strong>{plan.transactions.length}</strong>
              </div>
            </div>

            <p className="setup-role-summary"><b>{role.name}</b> · key <code>{role.key}</code> · {role.members.length} member(s) · {role.permissions.length} permission(s)</p>
            <div className="review-list">
              <div className="review-row">
                <span className="change-glyph added">+</span>
                <span>
                  <b>Deploy the modifier</b>
                  <small>
                    Through the Zodiac factory at {shortHex(MODULE_PROXY_FACTORY)} · lands at{" "}
                    {plan.predictedAddress}
                  </small>
                  <small className="rationale">
                    Owner, avatar and target are all this Safe: the Safe governs the
                    modifier, permissions act on the Safe, and calls route through it.
                  </small>
                </span>
                <span className="risk-badge low">Low</span>
              </div>
              <div className="review-row">
                <span className="change-glyph added">+</span>
                <span>
                  <b>Enable it as a Safe module</b>
                  <small>{safeAddress} · enableModule</small>
                  <small className="rationale">
                    Grants the modifier authority to execute from this Safe.
                    The first role and its permissions are configured in this same atomic batch.
                  </small>
                </span>
                <span className="risk-badge critical">Critical</span>
              </div>
              {plan.changes.map(change => <div className="review-row" key={change.id}>
                <span className="change-glyph added">+</span>
                <span><b>{change.summary}</b><small>{change.scope} · {change.detail}</small>{change.rationale && <small className="rationale">{change.rationale}</small>}</span>
                <span className={`risk-badge ${change.risk.toLowerCase()}`}>{change.risk}</span>
              </div>)}
            </div>
            <details className="setup-technical"><summary>Advanced deployment details</summary>
            <label className="modal-field">
              <span>Salt</span>
              <div className="adopt-row">
                <input
                  className="mono-input"
                  value={saltNonce}
                  onChange={(event) => setSaltNonce(event.target.value.replace(/\D/g, ""))}
                  disabled={state === "submitting" || state === "done"}
                />
                <button
                  className="button secondary"
                  onClick={() => setSaltNonce(freshSaltNonce())}
                  disabled={state === "submitting" || state === "done"}
                >
                  New salt
                </button>
              </div>
              <small>
                Changes the derived address. Use a new salt if the target address is
                already occupied.
              </small>
            </label>
            </details>
          </>
        )}
        </>}

        {state === "done" && submission && (
          <div className="proposal-success">
            <span>✓</span>
            <p>
              <b>Submitted via {submitter?.label}</b>
              {submissionReferences(submission).map((reference) => (
                <code key={reference}>{shortHex(reference, 14, 12)}</code>
              ))}
            </p>
            <small>
              Submitted does not mean executed. Once the Safe executes this batch,
              the modifier and first role will be live at {plan?.predictedAddress}.
              Wait for execution before opening its indexed policy.
            </small>
            <button className="button secondary" disabled={execution.checking || !submitter || submitter.chainId !== chainId} onClick={() => void checkExecution()}>
              {execution.checking ? "Checking execution…" : "Check execution and open roles"}
            </button>
            {execution.message && <small role="status">{execution.message}</small>}
          </div>
        )}

        {message && (
          <div className="connection-error" role="alert">
            <b>Not submitted</b>
            <p>{message}</p>
          </div>
        )}

        <div className="modal-actions">
          {step==="review" && state!=="done" && !ready && <div id="setup-submit-blocker" className="submission-blocker" role="status">
            <b>{blockers[0] ?? "Complete the checks before submitting."}</b>
            <div><button type="button" className="button ghost" onClick={()=>checksRef.current?.scrollIntoView({block:"start",behavior:"smooth"})}>View checks{blockers.length>1?` (${blockers.length} remaining)`:""}</button>
            {submitter && <button type="button" className="button ghost" onClick={retryChecks}>Retry checks</button>}</div>
          </div>}
          <button onClick={onClose} disabled={state === "submitting"}>
            {state === "done" ? "Close" : "Cancel"}
          </button>
          {step === "role" ? (
            <button type="button" className="button primary" onClick={()=>{
              if(!plan || plan.issues.length>0){
                setShowRoleIssues(true);
                requestAnimationFrame(()=>{roleIssuesRef.current?.scrollIntoView({block:"nearest",behavior:"smooth"});roleIssuesRef.current?.focus({preventScroll:true});});
                return;
              }
              setShowRoleIssues(false);setStep("review");
            }}>Review initialization</button>
          ) : <>
            {state !== "done" && <button className="button secondary" disabled={state === "submitting"} onClick={() => setStep("role")}>Back to role</button>}
          <button
            className="button primary"
            onClick={() => void submit()}
            aria-describedby={!ready?"setup-submit-blocker":undefined}
            disabled={!ready || state === "submitting" || state === "done"}
          >
            {state === "submitting"
              ? "Submitting…"
              : state === "done"
                ? "Submitted"
                : !submitter
                  ? "Connect a wallet or open in Safe"
                  : "Deploy, enable and configure"}
          </button>
          </>}
        </div>
      </section>
    </ConfigurationPage>
  );
}
