/** Observations from Safe infrastructure; never used to authorize submissions. */
export type SafeTransactionStatus = {
  state: "awaiting-confirmations" | "awaiting-execution" | "success" | "failed" | "cancelled" | "unknown";
  confirmations: number | null;
  required: number | null;
  transactionHash: string | null;
  observedAt: number;
  source: "safe-host" | "safe-service";
};
type Scope = { safeAddress: string; safeTxHash: string };
const address = /^0x[\da-f]{40}$/i;
const hash = /^0x[\da-f]{64}$/i;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed Safe transaction response.");
  return value as Record<string, unknown>;
}
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function match(value: unknown, expected: string) {
  if (typeof value !== "string" || value.toLowerCase() !== expected.toLowerCase()) throw new Error("Safe transaction response does not match the requested Safe and hash.");
}
function txHash(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !hash.test(value)) throw new Error("Invalid execution transaction hash.");
  return value;
}
export function validateSafeTransactionScope(scope: Scope) {
  if (!address.test(scope.safeAddress) || !hash.test(scope.safeTxHash)) throw new Error("Invalid Safe address or transaction hash.");
}
export function parseHostTransaction(value: unknown, scope: Scope): SafeTransactionStatus {
  validateSafeTransactionScope(scope);
  const tx = record(value);
  match(tx.safeAddress, scope.safeAddress);
  const details = record(tx.detailedExecutionInfo);
  match(details.safeTxHash, scope.safeTxHash);
  const states: Record<string, SafeTransactionStatus["state"]> = {
    AWAITING_CONFIRMATIONS: "awaiting-confirmations", AWAITING_EXECUTION: "awaiting-execution",
    SUCCESS: "success", FAILED: "failed", CANCELLED: "cancelled",
  };
  return { state: typeof tx.txStatus === "string" ? states[tx.txStatus] ?? "unknown" : "unknown",
    confirmations: Array.isArray(details.confirmations) ? details.confirmations.length : null,
    required: count(details.confirmationsRequired), transactionHash: txHash(tx.txHash),
    observedAt: Date.now(), source: "safe-host" };
}
export function parseServiceTransaction(value: unknown, scope: Scope): SafeTransactionStatus {
  validateSafeTransactionScope(scope);
  const tx = record(value);
  match(tx.safe, scope.safeAddress); match(tx.safeTxHash, scope.safeTxHash);
  if (typeof tx.isExecuted !== "boolean") throw new Error("Safe execution status is missing.");
  // Count distinct owners, never arbitrary array entries or duplicate signatures.
  const owners = Array.isArray(tx.confirmations) ? tx.confirmations.map(entry => record(entry).owner) : [];
  if (owners.some(owner => typeof owner !== "string" || !address.test(owner))) throw new Error("Invalid Safe confirmations.");
  const confirmations = new Set((owners as string[]).map(owner => owner.toLowerCase())).size;
  const required = count(tx.confirmationsRequired);
  if (required === null || required === 0 || !Array.isArray(tx.confirmations)) throw new Error("Safe confirmation threshold is missing.");
  const state = tx.isExecuted
    ? tx.isSuccessful === true ? "success" : tx.isSuccessful === false ? "failed" : "unknown"
    : confirmations >= required ? "awaiting-execution" : "awaiting-confirmations";
  return {state, confirmations, required, transactionHash: txHash(tx.transactionHash), observedAt:Date.now(), source:"safe-service"};
}
