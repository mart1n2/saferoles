import { ConfigurationPage } from "./components/configuration-page";

import { useEffect, useRef, useState } from "react";
import { shortHex } from "./lib/abi";
import { safeTransactionUrl } from "./lib/chains";
import type { DraftPolicy, PolicyIssue } from "./lib/policy";
import type { ChainFacts, Scope, usePolicy } from "./lib/use-policy";
import { verifyModifier, type useSafe } from "./lib/use-safe";
import {
  PartialSubmissionError,
  submissionReferences,
  type SubmissionResult,
} from "./lib/submission";
import { recordLocalSubmission } from "./lib/local-workspace";
import { verifyWalletForModifier, type useWallet } from "./lib/use-wallet";
import { SafeTransactionStatusView } from "./components/safe-transaction-status";

export type SubmitVia = "safe-app" | "wallet" | "none";

export function ReviewPage({
  plan,
  draft,
  draftId,
  scope,
  facts,
  safe,
  wallet,
  submitVia,
  verification,
  canSubmit,
  recheckBaseline,
  markSubmitted,
  onClose,
  onFixIssue,
  onBaselineChanged,
  onSubmitted,
}: {
  plan: ReturnType<typeof usePolicy>["plan"];
  draft: DraftPolicy;
  draftId: string | null;
  scope: Scope;
  facts: ChainFacts;
  safe: ReturnType<typeof useSafe>;
  wallet: ReturnType<typeof useWallet>;
  submitVia: SubmitVia;
  verification: { ok: boolean; problems: string[] };
  canSubmit: boolean;
  recheckBaseline: ReturnType<typeof usePolicy>["recheckBaseline"];
  markSubmitted: ReturnType<typeof usePolicy>["markSubmitted"];
  onClose: () => void;
  /** Jumps back to the role/permission a blocking issue belongs to. */
  onFixIssue?: (issue: PolicyIssue) => void;
  onBaselineChanged: (reason: "changed" | "indexer-pending") => void;
  onSubmitted: () => void;
}) {
  const [state, setState] = useState<
    "idle" | "checking" | "submitting" | "partial" | "done" | "error"
  >("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [submission, setSubmission] = useState<SubmissionResult | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);

  const critical = plan.risk === "Critical";
  const safeAddress =
    submitVia === "wallet" ? wallet.account : safe.info?.safeAddress ?? null;
  const locked = state === "checking" || state === "submitting";

  useEffect(() => {
    window.scrollTo(0,0);
    dialogRef.current?.focus({preventScroll:true});
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !locked) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [locked, onClose]);

  async function recordSubmission(result: SubmissionResult): Promise<void> {
    if (!safeAddress) throw new Error("The submitting Safe address is unavailable.");
    await recordLocalSubmission({draftId,chainId:scope.chainId,rolesMod:scope.rolesMod,safeAddress,submission:result,risk:plan.risk,calls:plan.calls});
  }

  async function submit() {
    if (submitVia === "none") return;
    setState("checking");
    setMessage(null);
    setSubmission(null);

    try {
      const baseline = await recheckBaseline();
      if (!baseline.fresh) {
        onBaselineChanged(baseline.reason);
        return;
      }

      // Re-read authorization immediately before opening the signing prompt.
      // A check made when the editor first loaded is not sufficient: Safe
      // modules, account selection and chain can all change independently.
      const freshVerification =
        submitVia === "wallet"
          ? await (async () => {
              if (!wallet.account) {
                return {
                  ok: false,
                  problems: ["Connect the owning Safe before submitting."],
                };
              }
              const inspection = await wallet.inspectSafe(
                wallet.account,
                scope.rolesMod,
              );
              return verifyWalletForModifier({
                account: wallet.account,
                chainId: wallet.chainId,
                owner: facts.owner,
                avatar: facts.avatar,
                target: facts.target,
                modifierChainId: scope.chainId,
                safeStatus: inspection.status,
                moduleEnabled: inspection.moduleEnabled,
              });
            })()
          : verifyModifier({
              info: safe.info,
              owner: facts.owner,
              avatar: facts.avatar,
              target: facts.target,
              rolesMod: scope.rolesMod,
              chainId: scope.chainId,
              moduleEnabled: await safe.isModuleEnabled(scope.rolesMod),
            });
      if (!freshVerification.ok) {
        throw new Error(freshVerification.problems.join(" "));
      }

      setState("submitting");
      const payload = plan.transactions.map((transaction) => ({
        to: transaction.to,
        value: transaction.value,
        data: transaction.data,
      }));
      const result =
        submitVia === "wallet"
          ? await wallet.send(payload)
          : await safe.propose(payload);

      setSubmission(result);
      setState("done");
      markSubmitted();

      // Recording is best-effort because the external submission has already
      // happened, but a non-2xx response is surfaced rather than silently
      // reported as saved.
      try {
        await recordSubmission(result);
      } catch (caught) {
        setMessage(
          `Submitted, but history was not saved: ${
            caught instanceof Error ? caught.message : "unknown storage failure"
          }`,
        );
      }
      onSubmitted();
    } catch (caught) {
      if (caught instanceof PartialSubmissionError) {
        setSubmission(caught.submission);
        setState("partial");
        setMessage(caught.message);
        markSubmitted();
        return;
      }
      setState("error");
      setMessage(
        caught instanceof Error ? caught.message : "The submission failed.",
      );
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
          (_key, value) =>
            typeof value === "bigint" ? value.toString() : value,
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

  const safeUrl =
    submission?.kind === "safeTxHash" && safeAddress
      ? safeTransactionUrl(
          scope.chainId,
          safeAddress,
          submission.safeTxHash,
        )
      : null;

  return (
    <ConfigurationPage onBack={onClose} backLabel="Back to editing" busy={locked} wallet={safe.mode!=="safe-app"?wallet:null} requiredChainId={scope.chainId}>
      <section
        ref={dialogRef}
        className="configuration-sheet review-page"
        aria-labelledby="review-title"
        tabIndex={-1}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">Pre-flight review</span>
            <h1 id="review-title">Review your changes</h1>
            <p>
              Diffed against the modifier&apos;s indexed snapshot. The
              baseline and Safe authorization are checked again immediately
              before submission.
            </p>
          </div>

        </div>

        <div className="review-summary">
          <div>
            <span>Onchain calls</span>
            <strong>{plan.transactions.length}</strong>
          </div>
          <div>
            <span>Roles touched</span>
            <strong>
              {new Set(plan.changes.map((change) => change.scope)).size}
            </strong>
          </div>
          <div>
            <span>Highest risk</span>
            <strong className={`risk-text ${plan.risk.toLowerCase()}`}>
              {plan.risk}
            </strong>
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
              While any value is invalid its role cannot be encoded, and an
              unencodable role would look like a request to revoke everything in
              it. Nothing is planned until these are resolved.
            </p>
            <ul>
              {plan.issues.map((issue, index) => {
                const roleName = issue.roleId
                  ? draft.roles.find((role) => role.id === issue.roleId)?.name ||
                    draft.roles.find((role) => role.id === issue.roleId)?.key
                  : null;
                return (
                  <li key={`${issue.message}-${index}`}>
                    {roleName ? <b>{roleName}: </b> : null}
                    {issue.message}
                    {issue.roleId && onFixIssue && (
                      <>
                        {" "}
                        <button className="button ghost" onClick={() => onFixIssue(issue)}>
                          Go fix this
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {plan.issues.length === 0 && (
          <div className="review-list">
            {plan.changes.map((change) => (
              <div className="review-row" key={change.id}>
                <span
                  className={`change-glyph ${
                    change.action === "Revoke"
                      ? "removed"
                      : change.action === "Grant"
                        ? "added"
                        : "updated"
                  }`}
                >
                  {change.action === "Revoke"
                    ? "−"
                    : change.action === "Grant"
                      ? "+"
                      : "~"}
                </span>
                <span>
                  <b>{change.summary}</b>
                  <small>
                    {change.scope} · {change.detail}
                  </small>
                  {change.rationale && (
                    <small className="rationale">{change.rationale}</small>
                  )}
                </span>
                <span className={`risk-badge ${change.risk.toLowerCase()}`}>
                  {change.risk}
                </span>
              </div>
            ))}
            {plan.changes.length === 0 && (
              <p className="inline-empty">
                The draft matches the indexed snapshot. Nothing to propose.
              </p>
            )}
          </div>
        )}

        {critical && (
          <div className="guardrail-callout critical">
            <b>Critical change blocked</b>
            <p>
              This batch enables delegatecall, which lets the target run code
              against the Safe&apos;s own storage and balances. Remove it, or
              configure it in the Zodiac Roles app where that risk is presented
              in full.
            </p>
          </div>
        )}

        {submitVia === "none" && (
          <div className="banner info">
            <b>No wallet connected</b>
            <p>
              You can review and export this diff now. To submit it, connect a
              Safe-aware wallet with your Safe selected, or open SafeRoles inside Safe.
            </p>
          </div>
        )}

        {submitVia !== "none" && !verification.ok && (
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
            <p>
              The Safe UI reports no signer, so a proposal cannot be submitted.
            </p>
          </div>
        )}

        {submitVia === "wallet" && wallet.batchSupport === "sequential" && (
          <div className="guardrail-callout medium">
            <b>
              {plan.transactions.length} separate confirmation
              {plan.transactions.length === 1 ? "" : "s"}
            </b>
            <p>
              This wallet cannot submit an atomic batch, so each call is
              confirmed and applied on its own. Stopping partway leaves the
              policy partially updated.
            </p>
          </div>
        )}

        {(state === "done" || state === "partial") && submission && (
          <div className="proposal-success">
            <span>{state === "done" ? "✓" : "!"}</span>
            <p>
              <b>
                {state === "partial"
                  ? "Partially submitted"
                  : submission.kind === "safeTxHash"
                    ? "Queued in the Safe"
                    : submission.kind === "bundleId"
                      ? "Submitted as a wallet bundle"
                      : "Submitted through your wallet"}
              </b>
              {submissionReferences(submission).map((reference) => (
                <code key={reference}>{shortHex(reference, 14, 12)}</code>
              ))}
            </p>
            {safeUrl && (
              <a
                className="button secondary"
                href={safeUrl}
                target="_blank"
                rel="noreferrer"
              >
                View in Safe ↗
              </a>
            )}
          </div>
        )}

        {submission?.kind === "safeTxHash" && safeAddress && <SafeTransactionStatusView chainId={scope.chainId} safeAddress={safeAddress} safeTxHash={submission.safeTxHash} safe={safe}/>}

        {message && (
          <div
            className={
              state === "error" || state === "partial"
                ? "connection-error"
                : "banner info"
            }
            role="alert"
          >
            <b>
              {state === "error"
                ? "Not submitted"
                : state === "partial"
                  ? "Reconciliation required"
                  : "Note"}
            </b>
            <p>{message}</p>
          </div>
        )}

        <div className="modal-actions">
          <button onClick={onClose} disabled={locked}>
            Back to editing
          </button>
          <button
            className="button secondary"
            onClick={exportPolicy}
            disabled={locked}
          >
            Export JSON
          </button>
          <button
            className="button primary"
            onClick={() => void submit()}
            disabled={
              !canSubmit ||
              critical ||
              locked ||
              state === "done" ||
              state === "partial"
            }
          >
            {state === "checking"
              ? "Checking indexed state…"
              : state === "submitting"
                ? "Submitting…"
                : state === "done"
                  ? "Submitted"
                  : submitVia === "none"
                    ? "Connect a wallet or open in Safe"
                    : `${submitVia === "wallet" ? "Submit" : "Propose"} ${plan.transactions.length} call${plan.transactions.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </section>
    </ConfigurationPage>
  );
}
