/**
 * The draft policy model.
 *
 * This is the app's editable representation of a Zodiac Roles configuration.
 * Two rules govern it:
 *
 * 1. Values that end up in calldata are stored separately from anything shown
 *    to a human. `value` is encoded; `label` never is. Editing a label can
 *    therefore never change a permission.
 * 2. On-chain conditions the flat editor cannot represent are preserved
 *    verbatim in `rawCondition` rather than approximated, so round-tripping a
 *    real policy never silently weakens it.
 */
import type { Annotation, Condition, Target } from "zodiac-roles-sdk";

/** Operators the structured condition editor can express. */
export type ConditionOperator =
  | "pass"
  | "eq"
  | "avatar"
  | "withinAllowance"
  | "gt"
  | "gte"
  | "lt"
  | "lte";

export const conditionOperators: readonly ConditionOperator[] = [
  "pass",
  "eq",
  "avatar",
  "withinAllowance",
  "gt",
  "gte",
  "lt",
  "lte",
];

export const conditionOperatorLabels: Record<ConditionOperator, string> = {
  pass: "Any value",
  eq: "Equal to",
  avatar: "Equal to avatar",
  withinAllowance: "Within allowance",
  gt: "Greater than",
  gte: "At least",
  lt: "Less than",
  lte: "At most",
};

export type DraftCondition = {
  id: string;
  /** Zero-based position of the function parameter this constrains. */
  paramIndex: number;
  operator: ConditionOperator;
  /**
   * The value to encode, as typed by the user. Parsed against the parameter's
   * ABI type at encode time. Never contains display text.
   */
  value: string;
  /** Display-only annotation. Never encoded. */
  label?: string;
};

export type PermissionMode = "function" | "target";

export type DraftPermission = {
  id: string;
  /** Display-only name for the target contract. */
  name: string;
  targetAddress: string;
  /**
   * `target` clears the whole contract (every function). `function` scopes a
   * single function, optionally with parameter conditions.
   */
  mode: PermissionMode;
  /**
   * Canonical function signature, e.g. `transfer(address,uint256)`.
   *
   * The selector hashes from this, so it is the only form used for encoding.
   */
  signature: string;
  /**
   * The same function with its parameter names, e.g.
   * `transfer(address to, uint256 value)`, kept once resolved from an ABI.
   *
   * Display only, and never encoded — like {@link DraftCondition.label}. Held on
   * the permission so a list of them stays readable without re-fetching every
   * target's ABI.
   */
  signatureLabel?: string;
  /**
   * Set when the on-chain policy referenced a selector whose signature is
   * unknown. The permission is read-only until a matching signature is adopted.
   */
  selector?: string;
  /** Roles `ExecutionOptions`: whether the call may send value. */
  send: boolean;
  /** Roles `ExecutionOptions`: whether the call may delegatecall. */
  delegatecall: boolean;
  conditions: DraftCondition[];
  /**
   * A condition tree imported from chain that the flat editor cannot represent
   * (nested and/or, tuple matching, bitmasks). Passed through untouched when
   * planning. When set, `conditions` is ignored.
   */
  rawCondition?: Condition;
};

export type DraftMember = {
  id: string;
  address: string;
  /** Display-only. */
  label?: string;
};

/**
 * Allowances are global to the Roles modifier, not per-role. Conditions
 * reference one by key.
 */
export type DraftAllowance = {
  id: string;
  /** Human-readable key, or a 0x-prefixed bytes32. */
  key: string;
  /** All amounts are integer base units of the constrained asset. */
  balance: string;
  maxRefill: string;
  refill: string;
  /** Refill period in seconds. `0` means the allowance never refills. */
  period: string;
  /**
   * Start of the current refill window, as stored on chain. Carried through
   * untouched on edit: `setAllowance` overwrites every field, so dropping this
   * would silently restart the window and refund spend.
   */
  timestamp: string;
  label?: string;
};

export type DraftRole = {
  /** Stable local identity, independent of key and name, so renames are safe. */
  id: string;
  /** The on-chain role key: a human string (encoded to bytes32) or raw bytes32. */
  key: string;
  name: string;
  description: string;
  members: DraftMember[];
  permissions: DraftPermission[];
  /**
   * Off-chain descriptive metadata posted alongside the role. Carried through
   * untouched: dropping it would plan an annotation deletion the user never
   * asked for.
   */
  annotations?: Annotation[];
  /**
   * Target rows read from chain that the permission model cannot reproduce —
   * most commonly a target scoped to no functions, which grants nothing.
   *
   * They are replayed verbatim into the desired state so that importing a
   * policy and changing one unrelated field does not plan incidental cleanup of
   * state the user never touched.
   */
  residualTargets?: Target[];
};

export type DraftPolicy = {
  chainId: number;
  rolesMod: string;
  roles: DraftRole[];
  allowances: DraftAllowance[];
};

/** A blocking validation problem, addressed to the thing that caused it. */
export type PolicyIssue = {
  message: string;
  roleId?: string;
  permissionId?: string;
  conditionId?: string;
  allowanceId?: string;
  memberId?: string;
};

export function emptyPolicy(chainId: number, rolesMod: string): DraftPolicy {
  return { chainId, rolesMod, roles: [], allowances: [] };
}

/** Operators that constrain a numeric parameter. */
export function isNumericOperator(operator: ConditionOperator): boolean {
  return (
    operator === "gt" ||
    operator === "gte" ||
    operator === "lt" ||
    operator === "lte" ||
    operator === "withinAllowance"
  );
}

/** Operators that carry no comparison value of their own. */
export function isValuelessOperator(operator: ConditionOperator): boolean {
  return operator === "pass" || operator === "avatar";
}
