/**
 * Remembers what a submission sent, so the same calls are not sent twice.
 *
 * A submission takes effect only once its transactions are mined (or, for a
 * Safe proposal, signed and executed). Until the chain shows that, a diff
 * rebuilt from the chain state still contains calls that already went out —
 * resending them repeats calls such as ScopeTarget. Each submission is recorded
 * before the first signing prompt, with the baseline it was built on, the draft
 * that was submitted and a digest of every transaction that went out (or may
 * have). Records are per chain and modifier, one per submission, so they hold
 * across reloads and tabs.
 *
 * A record settles once the chain state has moved and the submitted draft,
 * planned against it, no longer produces any of the sent transactions: every
 * sent call has then taken effect, including when only part of a sequential
 * submission was mined at first and the rest followed.
 */
import { allowedKeys, baseHash, clearSavedForm, formKeys, readSavedForm, record, writeSavedForm } from "./form-drafts";
import { localList } from "./local-db";
import type { DraftPolicy } from "./policy";
import { lockDeployedRoleKeys, toSdkState, type SdkState } from "./policy-codec";
import { buildPlan, type EncodedTransaction } from "./policy-plan";
import { parse, parseDraftPolicy } from "./serialize";
import type { SubmissionResult } from "./submission";

/**
 * - `sending`: a signing prompt was opened and the outcome is unknown, because
 *   the page closed before it finished.
 * - `proposed`: a Safe proposal was created and may still wait for signatures.
 * - `sent`: wallet transactions were broadcast.
 */
export type SubmissionStatus = "sending" | "proposed" | "sent";

export type SubmissionMark = {
  id: string;
  /** Fingerprint of the chain state the submission was built on. */
  baseHash: string;
  status: SubmissionStatus;
  /** Digests of the transactions that went out, or may have. */
  sent: string[];
  /** The submitted draft, to tell when every sent call has taken effect. */
  policy: DraftPolicy;
  savedAt: number;
};

/** A proposal can wait for signatures indefinitely; it must not stall new work for that long. */
export const PROPOSAL_BLOCK_MS = 15 * 60 * 1000;
/** Broadcast transactions are only waiting to be mined; one still missing after a day was most likely dropped. */
export const SENT_BLOCK_MS = 24 * 60 * 60 * 1000;

const MAX_SENT = 4_096;
const STATUSES: readonly SubmissionStatus[] = ["sending", "proposed", "sent"];

export function blockedUntil(mark: Pick<SubmissionMark, "status" | "savedAt">): number {
  return mark.savedAt + (mark.status === "proposed" ? PROPOSAL_BLOCK_MS : SENT_BLOCK_MS);
}

/** What the chain state looks like now, from one submission's point of view. */
export type SubmissionCheck = {
  stateHash: string;
  /** Digests of what the open draft would send now. */
  planned: readonly string[];
  /** Digests of what the submitted draft would still send now. */
  outstanding: readonly string[];
};

/**
 * - `settled`: every sent call has taken effect, or the record expired; remove it.
 * - `blocks`: the chain still shows the baseline, or the open draft would send a
 *   call that already went out.
 * - `open`: still pending, but the open draft repeats none of it.
 */
export function submissionVerdict(
  mark: SubmissionMark,
  check: SubmissionCheck,
  now: number = Date.now(),
): "settled" | "blocks" | "open" {
  if (now < mark.savedAt || now >= blockedUntil(mark)) return "settled";
  const sent = new Set(mark.sent);
  if (check.stateHash !== mark.baseHash && !check.outstanding.some((digest) => sent.has(digest))) {
    return "settled";
  }
  return check.stateHash === mark.baseHash || check.planned.some((digest) => sent.has(digest))
    ? "blocks"
    : "open";
}

/** The role and allowance transactions a draft produces against `current`, without unwrapper calls. */
export function diffTransactions(policy: DraftPolicy, current: SdkState, rolesMod: string): EncodedTransaction[] {
  const { state, issues } = toSdkState(lockDeployedRoleKeys(policy, current));
  return buildPlan({ rolesMod, current, desired: state, issues }).transactions;
}

export async function transactionDigests(
  transactions: readonly { to: string; value: string; data: string }[],
): Promise<string[]> {
  return Promise.all(
    transactions.map(async (tx) => {
      const text = `${tx.to.toLowerCase()}:${BigInt(tx.value)}:${tx.data.toLowerCase()}`;
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }),
  );
}

/** How many of the submitted transactions went out, by what the wallet or Safe returned. */
export function sentCount(result: SubmissionResult, total: number): number {
  return result.kind === "txHashes" ? Math.min(result.txHashes.length, total) : total;
}

export function statusAfter(result: SubmissionResult): SubmissionStatus {
  return result.kind === "safeTxHash" ? "proposed" : "sent";
}

type Scope = { chainId: number; rolesMod: string };

function parseMark(value: unknown, scope: Scope): Omit<SubmissionMark, "id" | "savedAt"> {
  const row = record(value, "submission");
  allowedKeys(row, ["baseHash", "status", "sent", "policy"], "submission");
  const hash = baseHash(row.baseHash);
  if (!hash) throw new Error("submission.baseHash is required.");
  if (!STATUSES.includes(row.status as SubmissionStatus)) throw new Error("submission.status is not supported.");
  if (!Array.isArray(row.sent) || row.sent.length > MAX_SENT) {
    throw new Error(`submission.sent must be a list of at most ${MAX_SENT} digests.`);
  }
  return {
    baseHash: hash,
    status: row.status as SubmissionStatus,
    sent: row.sent.map((digest) => {
      const value = baseHash(digest);
      if (!value) throw new Error("submission.sent must contain digests.");
      return value;
    }),
    policy: parseDraftPolicy(row.policy, scope),
  };
}

/**
 * Persists a submission and says whether it was stored. A browser without
 * storage still has the caller's in-memory copy.
 */
export async function rememberSubmission(scope: Scope, mark: SubmissionMark): Promise<boolean> {
  const data = { baseHash: mark.baseHash, status: mark.status, sent: mark.sent, policy: mark.policy };
  try {
    await writeSavedForm(formKeys.submitted(scope.chainId, scope.rolesMod, mark.id), data);
    return true;
  } catch {
    return false;
  }
}

/** Every recorded submission for one modifier, from any tab. */
export async function readSubmissionMarks(scope: Scope): Promise<SubmissionMark[]> {
  const prefix = formKeys.submitted(scope.chainId, scope.rolesMod, "");
  let rows: string[];
  try {
    rows = await localList<string>("forms");
  } catch {
    return [];
  }
  const ids = rows.flatMap((raw) => {
    try {
      const key = (parse<unknown>(raw) as { key?: unknown } | null)?.key;
      return typeof key === "string" && key.startsWith(prefix) && key.length > prefix.length
        ? [key.slice(prefix.length)]
        : [];
    } catch {
      return [];
    }
  });
  const marks = await Promise.all(
    ids.map(async (id) => {
      const saved = await readSavedForm(formKeys.submitted(scope.chainId, scope.rolesMod, id), (value) =>
        parseMark(value, scope),
      );
      return saved ? { ...saved.data, id, savedAt: saved.savedAt } : null;
    }),
  );
  return marks.filter((mark): mark is SubmissionMark => mark !== null);
}

export async function clearSubmissionMark(scope: Scope, id: string): Promise<void> {
  await clearSavedForm(formKeys.submitted(scope.chainId, scope.rolesMod, id));
}
