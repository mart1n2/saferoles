import { listLocalSubmissions } from "../lib/local-workspace";
import { useEffect, useState } from "react";
import { safeTransactionUrl } from "../lib/chains";
import { shortHex } from "../lib/abi";
import { submissionReferences, type SubmissionResult } from "../lib/submission";
import type { SafeContext } from "../lib/use-safe";
import { SafeTransactionStatusView } from "./safe-transaction-status";
type ProposalRow = {
  id: string;
  safeAddress: string;
  submission: SubmissionResult;
  callCount: number;
  risk: string;
  proposedBy: string;
  createdAt: number;
};

export function ActivityPanel({ chainId, rolesMod, safe }: { chainId: number; rolesMod: string; safe:SafeContext }) {
  const [rows, setRows] = useState<ProposalRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const proposals=await listLocalSubmissions(chainId,rolesMod);
        if(!cancelled)setRows(proposals);
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
          <span className="eyebrow">Console record</span>
          <h3>Proposals from this browser</h3>
          <p>
            Stored only on this browser, per modifier. This is not
            cryptographic proof. Safe status is an infrastructure observation;
            the indexed policy is refreshed separately after execution.
          </p>
        </div>
      </div>
      <div className="timeline">
        {error && <p className="inline-empty">{error}</p>}
        {rows?.map((row,index) => {
          const url =
            row.submission.kind === "safeTxHash"
              ? safeTransactionUrl(
                  chainId,
                  row.safeAddress,
                  row.submission.safeTxHash,
                )
              : null;
          const references = submissionReferences(row.submission);
          return (
            <div className="timeline-item" key={row.id}>
              <span className="change-glyph updated">~</span>
              <div>
                <b>
                  {row.callCount} call{row.callCount === 1 ? "" : "s"} proposed
                </b>
                <span>
                  {new Date(row.createdAt).toLocaleString()}
                  {row.proposedBy ? ` · by ${row.proposedBy.slice(0, 160)}` : ""}
                </span>
                {references.map((reference) => (
                  <code key={reference}>{shortHex(reference, 12, 10)}</code>
                ))}
                {row.submission.kind === "safeTxHash" && <SafeTransactionStatusView chainId={chainId} safeAddress={row.safeAddress} safeTxHash={row.submission.safeTxHash} safe={safe} autoSync={index<3}/>}
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

