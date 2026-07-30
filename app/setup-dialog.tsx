/**
 * Deploy-and-enable flow for a new Roles modifier.
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
  buildSetupPlan,
  checksPass,
  evaluateMastercopy,
  freshSaltNonce,
  type SetupCheck,
  type SetupPlan,
} from "./lib/setup-roles";

export type SetupSubmitter = {
  /** Human-readable name of the route the batch will take. */
  label: string;
  submit: (
    transactions: { to: string; value: string; data: string }[],
  ) => Promise<SubmissionResult>;
  getCode: (address: string) => Promise<string | null>;
  chainId: number;
  /** Setup must be deploy+enable as one indivisible Safe operation. */
  atomic: boolean;
  /** The submitting address was positively identified as a Safe contract. */
  safeVerified: boolean;
};

export function SetupDialog({
  chainId,
  safeAddress,
  submitter,
  onClose,
  onDone,
}: {
  chainId: number;
  safeAddress: string;
  /** Null when nothing can submit; the dialog then explains rather than offering. */
  submitter: SetupSubmitter | null;
  onClose: () => void;
  onDone: (modifierAddress: string) => void;
}) {
  const [mastercopy] = useState(SUGGESTED_ROLES_MASTERCOPY);
  const [saltNonce, setSaltNonce] = useState(() => freshSaltNonce());
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
  const [submission, setSubmission] = useState<SubmissionResult | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);

  // The plan is derived, so the address shown is always the address that the
  // encoded batch will actually create.
  const plan = useMemo<SetupPlan | null>(() => {
    try {
      return buildSetupPlan({ safeAddress, mastercopy, saltNonce });
    } catch {
      return null;
    }
  }, [mastercopy, safeAddress, saltNonce]);

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
  }, [mastercopy, readCode]);

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
  }, [readCode]);

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
  }, [plan, readCode]);

  // Identity comes from the published source, not from the address matching a
  // constant in this app.
  useEffect(() => {
    if (!isAddress(mastercopy)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/abi?chainId=${chainId}&address=${mastercopy}`);
          const body = (await response.json()) as { abi?: ResolvedAbi | null };
          if (!cancelled) {
            setAbiFor({
              address: mastercopy,
              abi: response.ok ? (body.abi ?? null) : null,
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
  }, [chainId, mastercopy]);

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
      }),
    [abi, code, factoryCode, mastercopy, predictedCode, readCode],
  );

  const ready = Boolean(
    plan &&
      submitter &&
      submitter.chainId === chainId &&
      submitter.atomic &&
      submitter.safeVerified &&
      checksPass(checks),
  );

  const submit = useCallback(async () => {
    if (!plan || !submitter) return;
    setState("submitting");
    setMessage(null);
    try {
      const result = await submitter.submit(plan.transactions);
      setSubmission(result);
      setState("done");
      onDone(plan.predictedAddress);
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Nothing was submitted.");
    }
  }, [onDone, plan, submitter]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && state !== "submitting") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, state]);

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="modal review-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="setup-title"
        tabIndex={-1}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">First-time setup</span>
            <h2 id="setup-title">Deploy a Roles modifier</h2>
            <p>
              Creates a Roles modifier owned by {shortHex(safeAddress)} on{" "}
              {chainName(chainId)} and enables it as a Safe module, in one batch.
            </p>
          </div>
          <button
            className="icon-button"
            aria-label="Close"
            onClick={onClose}
            disabled={state === "submitting"}
          >
            ×
          </button>
        </div>

        <div className="guardrail-callout critical">
          <b>Enabling a module is a permanent grant of authority</b>
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

        <div className="check-list">
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
            <p>Select the Safe contract account, not an owner EOA.</p>
          </div>
        )}

        {submitter && !submitter.atomic && (
          <div className="guardrail-callout critical" role="alert">
            <b>Atomic setup is required</b>
            <p>
              Deploying and enabling must be submitted as one Safe batch. A
              sequential wallet could stop after deployment and leave setup in an
              ambiguous partial state, so this path is blocked.
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
                    Grants the modifier authority to execute from this Safe. Until a role
                    is configured it can do nothing, because every call is denied by
                    default.
                  </small>
                </span>
                <span className="risk-badge critical">Critical</span>
              </div>
            </div>

            <label className="modal-field">
              <span>Salt</span>
              <div className="adopt-row">
                <input
                  className="mono-input"
                  value={saltNonce}
                  onChange={(event) => setSaltNonce(event.target.value.replace(/\D/g, ""))}
                  disabled={state === "submitting"}
                />
                <button
                  className="button secondary"
                  onClick={() => setSaltNonce(freshSaltNonce())}
                  disabled={state === "submitting"}
                >
                  New salt
                </button>
              </div>
              <small>
                Changes the derived address. Use a new salt if the target address is
                already occupied.
              </small>
            </label>
          </>
        )}

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
              Once executed, the modifier will be live at {plan?.predictedAddress}. It has
              no roles yet, so it permits nothing until you configure one.
            </small>
          </div>
        )}

        {message && (
          <div className="connection-error" role="alert">
            <b>Not submitted</b>
            <p>{message}</p>
          </div>
        )}

        <div className="modal-actions">
          <button onClick={onClose} disabled={state === "submitting"}>
            {state === "done" ? "Close" : "Cancel"}
          </button>
          <button
            className="button primary"
            onClick={() => void submit()}
            disabled={!ready || state === "submitting" || state === "done"}
          >
            {state === "submitting"
              ? "Submitting…"
              : state === "done"
                ? "Submitted"
                : !submitter
                  ? "Connect a wallet or open in Safe"
                  : "Deploy and enable"}
          </button>
        </div>
      </section>
    </div>
  );
}
