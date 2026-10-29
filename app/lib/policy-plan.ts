/**
 * Turns "current on-chain state vs. desired draft" into the exact set of
 * Roles modifier calls through the local compatibility planner, and describes them for review.
 *
 * The diff shown to a reviewer and the calldata that gets signed come from the
 * same place: the SDK's planned call list. There is no separate edit log that
 * could drift from what is actually being proposed.
 */
import {
  ExecutionOptions,
  Operator,
  ParameterType,
  decodeKey,
  type Condition,
} from "zodiac-roles-sdk";
import { callsPlannedForApply, encodeCalls, type Call } from "./zodiac-compat";
import type { SdkState } from "./policy-codec";
import type { DraftPermission, PolicyIssue } from "./policy";
import { shortHex } from "./abi";
import { encodeUnwrapCall, findUnwrapTarget, unwrapCallFor, type UnwrapCall } from "./unwrappers";

export type Risk = "Low" | "Medium" | "High" | "Critical";

export const riskOrder: Record<Risk, number> = {
  Low: 0,
  Medium: 1,
  High: 2,
  Critical: 3,
};

export function highestRisk(risks: readonly Risk[]): Risk {
  return risks.reduce<Risk>(
    (worst, risk) => (riskOrder[risk] > riskOrder[worst] ? risk : worst),
    "Low",
  );
}

/**
 * What a permission's parameter conditions amount to, independent of how they
 * are held: a raw tree imported from chain or the editor's decoded list must
 * rate the same, or the same grant would change rating when it is opened.
 *
 * - `open`: nothing is constrained.
 * - `simple`: flat conditions the editor can show (equals, avatar, bounds, allowance).
 * - `complex`: anything else, such as nesting or operators the editor cannot read.
 */
export type ConditionShape = "open" | "simple" | "complex";

const SIMPLE_OPERATORS: ReadonlySet<Operator> = new Set([
  Operator.Pass,
  Operator.EqualToAvatar,
  Operator.EqualTo,
  Operator.WithinAllowance,
  Operator.GreaterThan,
  Operator.LessThan,
]);

export function conditionShape(condition: Condition | undefined): ConditionShape {
  if (!condition) return "open";
  if (
    condition.paramType !== ParameterType.Calldata ||
    condition.operator !== Operator.Matches ||
    !condition.children
  ) {
    return isUnconstrained(condition) ? "open" : "complex";
  }
  let constrained = false;
  for (const child of condition.children) {
    if (child.children && child.children.length > 0) return "complex";
    if (!SIMPLE_OPERATORS.has(child.operator)) return "complex";
    if (child.operator !== Operator.Pass) constrained = true;
  }
  return constrained ? "simple" : "open";
}

/**
 * The single rating rule, shared by the editor list, the permission detail and
 * the review plan:
 *
 * - Critical: may delegatecall.
 * - High: nothing is constrained, so any recipient or amount is permitted.
 * - Medium: may send native value, or carries a condition this editor cannot read.
 * - Low: constrained, no value, no delegatecall.
 */
export function rateGrant(
  shape: ConditionShape,
  options: { delegatecall: boolean; send: boolean },
): { risk: Risk; reason: string } {
  if (options.delegatecall) {
    return {
      risk: "Critical",
      reason: "Delegatecall runs the target's code with the Safe's own storage and balances.",
    };
  }
  if (shape === "open") {
    return {
      risk: "High",
      reason: "No parameter is constrained, so any recipient or amount is permitted.",
    };
  }
  if (options.send) {
    return { risk: "Medium", reason: "The call may also send native value." };
  }
  if (shape === "complex") {
    return {
      risk: "Medium",
      reason: "The deployed condition uses nesting or operators this editor cannot summarize, so it is preserved as deployed and rated cautiously.",
    };
  }
  return { risk: "Low", reason: "Parameters are constrained and no native value can be sent." };
}

function draftShape(permission: DraftPermission): ConditionShape {
  if (permission.rawCondition) return conditionShape(permission.rawCondition);
  // A condition still waiting for its value constrains nothing yet.
  return permission.conditions.some(
    (condition) =>
      condition.operator !== "pass" && (condition.operator === "avatar" || condition.value.trim() !== ""),
  )
    ? "simple"
    : "open";
}

/** Risk of a single draft permission, for the editor's own display. */
export function draftPermissionRisk(permission: DraftPermission): Risk {
  return draftRating(permission).risk;
}

function draftRating(permission: DraftPermission) {
  if (permission.mode === "target") {
    return permission.delegatecall
      ? rateGrant("open", permission)
      : {
          risk: "High" as Risk,
          reason: "Whole-contract clearance permits every function, including ones added by a future upgrade.",
        };
  }
  return rateGrant(draftShape(permission), permission);
}

export function riskReason(permission: DraftPermission): string {
  return draftRating(permission).reason;
}

export type PlannedChange = {
  id: string;
  call: Call | UnwrapCall;
  action: "Grant" | "Restrict" | "Revoke" | "Budget" | "Membership" | "Metadata" | "Batching";
  /** Decoded role key, or "—" for modifier-wide calls. */
  scope: string;
  summary: string;
  detail: string;
  risk: Risk;
  /** Why this carries the risk it does. Shown next to the row. */
  rationale?: string;
};

/** A piece of a change summary: plain text, or a contract the UI renders by name. */
export type SummaryPart = string | { contract: string };

/**
 * The review summary of a target or function change, with the contract left as
 * a reference and the selector replaced by the function's name when known, so
 * "Allow 0xa9059cbb on 0xdac1…1ec7" reads "Allow transfer on USDT". Anything
 * else keeps its plain summary.
 */
export function summaryParts(
  change: PlannedChange,
  functionName: (address: string, selector: string) => string | null,
): SummaryPart[] {
  const call = change.call as { call?: string; targetAddress?: string; selector?: string };
  const target = call.targetAddress;
  if (!target) return [change.summary];
  const readable = call.selector ? functionName(target, call.selector) : null;
  const name = readable ? readable.split("(")[0] : call.selector;
  switch (call.call) {
    case "allowTarget": return ["Allow every function on ", { contract: target }];
    case "scopeTarget": return ["Restrict ", { contract: target }, " to named functions"];
    case "revokeTarget": return ["Revoke all access to ", { contract: target }];
    case "allowFunction": return [`Allow ${name} on `, { contract: target }, " with any arguments"];
    case "scopeFunction": return [`Allow ${name} on `, { contract: target }, " under conditions"];
    case "revokeFunction": return [`Revoke ${name} on `, { contract: target }];
    default: return [change.summary];
  }
}

export type EncodedTransaction = {
  to: string;
  value: string;
  data: string;
  /** Roles calls are always plain calls from the Safe. */
  operation: 0;
};

export type Plan = {
  calls: (Call | UnwrapCall)[];
  transactions: EncodedTransaction[];
  changes: PlannedChange[];
  issues: PolicyIssue[];
  risk: Risk;
};

const emptyPlan: Plan = {
  calls: [],
  transactions: [],
  changes: [],
  issues: [],
  risk: "Low",
};

function allowsDelegateCall(options: ExecutionOptions): boolean {
  return (
    options === ExecutionOptions.DelegateCall || options === ExecutionOptions.Both
  );
}

function allowsSend(options: ExecutionOptions): boolean {
  return options === ExecutionOptions.Send || options === ExecutionOptions.Both;
}

function describeExecution(options: ExecutionOptions): string {
  const flags = [
    allowsSend(options) ? "can send value" : null,
    allowsDelegateCall(options) ? "can delegatecall" : null,
  ].filter(Boolean);
  return flags.length ? flags.join(", ") : "plain call only";
}

/**
 * True when a condition tree imposes no actual constraint — every leaf passes.
 *
 * Derived from the tree itself rather than from parameter names, so renaming a
 * label cannot change the assessed risk.
 */
function isUnconstrained(condition: Condition | undefined): boolean {
  if (!condition) return true;
  const comparing =
    condition.operator !== Operator.Pass &&
    condition.operator !== Operator.Matches;
  if (comparing) return false;
  if (!condition.children || condition.children.length === 0) {
    return condition.operator === Operator.Pass;
  }
  return condition.children.every(isUnconstrained);
}

function keyLabel(key: `0x${string}`): string {
  try {
    const decoded = decodeKey(key);
    return /^[\x20-\x7e]+$/.test(decoded) ? decoded : shortHex(key);
  } catch {
    return shortHex(key);
  }
}

function describeCall(
  call: Call,
  previousAllowances: Map<string, SdkState["allowances"][number]>,
): Omit<PlannedChange, "id" | "call"> {
  switch (call.call) {
    case "allowTarget":
      return {
        action: "Grant",
        scope: keyLabel(call.roleKey),
        summary: `Allow every function on ${shortHex(call.targetAddress)}`,
        detail: `${call.targetAddress} · ${describeExecution(call.executionOptions)}`,
        risk: allowsDelegateCall(call.executionOptions) ? "Critical" : "High",
        rationale: allowsDelegateCall(call.executionOptions)
          ? "Delegatecall runs the target's code with the Safe's own storage and balances."
          : "Whole-contract clearance permits every function, including ones added by a future upgrade.",
      };

    case "scopeTarget":
      return {
        action: "Restrict",
        scope: keyLabel(call.roleKey),
        summary: `Restrict ${shortHex(call.targetAddress)} to named functions`,
        detail: `${call.targetAddress} · individual functions are cleared separately`,
        risk: "Low",
        rationale: "Limits this contract to the individual functions allowed below; it grants nothing on its own.",
      };

    case "revokeTarget":
      return {
        action: "Revoke",
        scope: keyLabel(call.roleKey),
        summary: `Revoke all access to ${shortHex(call.targetAddress)}`,
        detail: call.targetAddress,
        risk: "Low",
        rationale: "Removes access.",
      };

    case "allowFunction":
      return {
        action: "Grant",
        scope: keyLabel(call.roleKey),
        summary: `Allow ${call.selector} on ${shortHex(call.targetAddress)} with any arguments`,
        detail: `${call.targetAddress} · ${describeExecution(call.executionOptions)}`,
        risk: allowsDelegateCall(call.executionOptions) ? "Critical" : "High",
        rationale: allowsDelegateCall(call.executionOptions)
          ? "Delegatecall runs the target's code with the Safe's own storage and balances."
          : "No parameter is constrained, so any recipient or amount is permitted.",
      };

    case "scopeFunction": {
      const rating = rateGrant(conditionShape(call.condition), {
        delegatecall: allowsDelegateCall(call.executionOptions),
        send: allowsSend(call.executionOptions),
      });
      return {
        action: "Grant",
        scope: keyLabel(call.roleKey),
        summary: `Allow ${call.selector} on ${shortHex(call.targetAddress)} under conditions`,
        detail: `${call.targetAddress} · ${describeExecution(call.executionOptions)}`,
        risk: rating.risk,
        rationale: rating.reason,
      };
    }

    case "revokeFunction":
      return {
        action: "Revoke",
        scope: keyLabel(call.roleKey),
        summary: `Revoke ${call.selector} on ${shortHex(call.targetAddress)}`,
        detail: call.targetAddress,
        risk: "Low",
        rationale: "Removes access.",
      };

    case "assignRoles":
      return {
        action: "Membership",
        scope: keyLabel(call.roleKey),
        summary: call.join
          ? `Grant the role to ${shortHex(call.member)}`
          : `Remove the role from ${shortHex(call.member)}`,
        detail: call.member,
        risk: call.join ? "Medium" : "Low",
        rationale: call.join
          ? "A new address gains every permission this role holds."
          : "Removes access.",
      };

    case "setAllowance": {
      const previous = previousAllowances.get(call.key.toLowerCase());
      const fasterRefill =
        previous !== undefined &&
        call.refill > 0n &&
        (previous.period === 0n ||
          call.period === 0n ||
          (call.period > 0n && call.period < previous.period));
      const raising =
        previous === undefined ||
        call.balance > previous.balance ||
        call.maxRefill > previous.maxRefill ||
        call.refill > previous.refill ||
        fasterRefill ||
        (previous !== undefined && call.timestamp !== previous.timestamp);
      const label = keyLabel(call.key);
      const period =
        call.period === 0n
          ? "one-time budget, no refill"
          : `refills ${call.refill} every ${call.period}s`;
      return {
        action: "Budget",
        scope: "modifier-wide",
        summary:
          previous === undefined
            ? `Create allowance "${label}" with a ceiling of ${call.maxRefill}`
            : `Set allowance "${label}" ceiling to ${call.maxRefill} (was ${previous.maxRefill})`,
        detail: `available now ${call.balance} · ${period}`,
        risk: raising ? "Medium" : "Low",
        rationale: raising
          ? "Raises the amount this budget permits to be spent."
          : "Lowers or holds the amount this budget permits.",
      };
    }

    case "postAnnotations":
      return {
        action: "Metadata",
        scope: keyLabel(call.roleKey),
        summary: "Update permission annotations",
        detail: "Off-chain descriptive metadata; grants no access.",
        risk: "Low",
      };
  }
}

function sameAllowance(
  left: SdkState["allowances"][number],
  right: SdkState["allowances"][number],
): boolean {
  return (
    left.key.toLowerCase() === right.key.toLowerCase() &&
    left.balance === right.balance &&
    left.maxRefill === right.maxRefill &&
    left.refill === right.refill &&
    left.period === right.period &&
    left.timestamp === right.timestamp
  );
}

/**
 * Diffs current against desired and encodes the result.
 *
 * Both inputs must be complete state. `current` comes from the modifier as
 * fetched; passing a fabricated baseline would compute a diff against something
 * that does not exist and emit calls that do not apply.
 */
function canonicalAddresses(state: SdkState): SdkState {
  return {
    ...state,
    roles: state.roles.map((role) => ({
      ...role,
      members: role.members.map((member) => member.toLowerCase() as `0x${string}`),
      targets: role.targets.map((target) => ({ ...target, address: target.address.toLowerCase() as `0x${string}` })),
    })),
  };
}

export function buildPlan({
  rolesMod,
  current,
  desired,
  issues = [],
}: {
  rolesMod: string;
  current: SdkState | null;
  desired: SdkState;
  issues?: PolicyIssue[];
}): Plan {
  if (!current) return { ...emptyPlan, issues };

  // Refuse to plan against an incomplete desired state.
  //
  // `callsPlannedForApply` treats absence as intent: a role missing from
  // `desired` means "revoke all of its permissions". Any validation issue makes
  // its role unencodable and therefore absent, so planning through issues would
  // turn one malformed field into a mass revocation of everything else in that
  // role — presented to reviewers as a legitimate diff. Issues must be resolved
  // before a diff means anything.
  if (issues.length > 0) return { ...emptyPlan, issues };

  let calls: Call[];
  try {
    // The planner compares addresses as strings. The indexer returns checksummed
    // ones while the editor emits lowercase, so without one canonical form an
    // untouched policy diffs as "revoke everything, then grant it again".
    calls = callsPlannedForApply(canonicalAddresses(current), canonicalAddresses(desired));
  } catch (error) {
    return {
      ...emptyPlan,
      issues: [
        ...issues,
        {
          message: `Could not plan the update: ${
            error instanceof Error ? error.message : "unknown planning failure"
          }`,
        },
      ],
    };
  }

  // The retained v3 planner ignores balance- and timestamp-only allowance
  // changes. Those fields are calldata-bearing state: silently dropping a
  // top-up would show a Budget edit while submitting no call. Fill any missing
  // allowance diff explicitly, while avoiding duplicates when the SDK already
  // emitted `setAllowance` for another changed field.
  const currentAllowances = new Map(
    current.allowances.map((allowance) => [
      allowance.key.toLowerCase(),
      allowance,
    ]),
  );
  const plannedAllowanceKeys = new Set(
    calls
      .filter(
        (call): call is Extract<Call, { call: "setAllowance" }> =>
          call.call === "setAllowance",
      )
      .map((call) => call.key.toLowerCase()),
  );
  for (const allowance of desired.allowances) {
    const key = allowance.key.toLowerCase();
    const previous = currentAllowances.get(key);
    if (
      !plannedAllowanceKeys.has(key) &&
      (!previous || !sameAllowance(previous, allowance))
    ) {
      calls.push({ call: "setAllowance", ...allowance });
      plannedAllowanceKeys.add(key);
    }
  }

  const previousAllowances = new Map(
    current.allowances.map((allowance) => [
      allowance.key.toLowerCase(),
      allowance,
    ]),
  );

  const changes: PlannedChange[] = calls.map((call, index) => ({
    id: `${call.call}-${index}`,
    call,
    ...describeCall(call, previousAllowances),
  }));

  let transactions: EncodedTransaction[] = [];
  const planIssues = [...issues];
  try {
    transactions = encodeCalls(calls, rolesMod as `0x${string}`).map((tx) => ({
      to: tx.to,
      value: "0",
      data: tx.data,
      operation: 0 as const,
    }));
  } catch (error) {
    planIssues.push({
      message: `Could not encode the planned calls: ${
        error instanceof Error ? error.message : "unknown encoding failure"
      }`,
    });
  }

  return {
    calls,
    transactions,
    changes,
    issues: planIssues,
    risk: highestRisk(changes.map((change) => change.risk)),
  };
}

/**
 * Adds the owner-only calls that enable batch unwrapping. They sit outside the
 * role/allowance diff because they configure the modifier itself, and are shown
 * to the reviewer like any other change.
 */
export function withUnwrappers(plan: Plan, rolesMod: string, chainId: number, ids: readonly string[] | undefined): Plan {
  if (!ids?.length || plan.issues.length > 0) return plan;
  const calls = [...plan.calls];
  const changes = [...plan.changes];
  const transactions = [...plan.transactions];
  for (const id of ids) {
    const call = unwrapCallFor(id, chainId);
    const target = findUnwrapTarget(id);
    if (!call || !target) continue;
    calls.push(call);
    transactions.push({ to: rolesMod, value: "0", data: encodeUnwrapCall(call), operation: 0 });
    changes.push({
      id: `unwrapper-${id}`,
      call,
      action: "Batching",
      scope: "—",
      summary: `Enable batched calls through ${target.label}`,
      detail: `${call.to} · adapter ${call.adapter}`,
      risk: "Medium",
      rationale: "Role members will be able to send batches here. Each inner call is still checked against their own permissions.",
    });
  }
  return { ...plan, calls, changes, transactions, risk: highestRisk(changes.map((change) => change.risk)) };
}
