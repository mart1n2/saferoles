/**
 * A transaction submission is not always a Safe transaction hash.
 *
 * Safe Apps return a Safe transaction hash, EIP-5792 wallets return a bundle
 * identifier, and the sequential wallet fallback returns one transaction hash
 * per call. Keeping those identities distinct prevents opaque wallet ids from
 * being rendered as invalid Safe transaction deep links.
 */
export type SubmissionResult =
  | { kind: "safeTxHash"; safeTxHash: string }
  | { kind: "bundleId"; bundleId: string }
  | { kind: "txHashes"; txHashes: string[] };

export function submissionReferences(result: SubmissionResult): string[] {
  switch (result.kind) {
    case "safeTxHash":
      return [result.safeTxHash];
    case "bundleId":
      return [result.bundleId];
    case "txHashes":
      return result.txHashes;
  }
}

/**
 * Sequential batches can fail after earlier calls were already broadcast.
 * Preserve the hashes so the UI never claims that nothing was submitted.
 */
export class PartialSubmissionError extends Error {
  readonly submission: Extract<SubmissionResult, { kind: "txHashes" }>;

  constructor(message: string, txHashes: string[], options?: ErrorOptions) {
    super(message, options);
    this.name = "PartialSubmissionError";
    this.submission = { kind: "txHashes", txHashes };
  }
}
