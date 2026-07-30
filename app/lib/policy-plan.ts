/**
 * Turns "current on-chain state vs. desired draft" into the exact set of
 * Roles modifier calls, and describes them for review.
 *
 * The diff shown to a reviewer and the calldata that gets signed come from the
 * same place: the SDK's planned call list. There is no separate edit log that
 * could drift from what is actually being proposed.
 */
import {
  ExecutionOptions,
  Operator,
  callsPlannedForApply,
  decodeKey,
  encodeCalls,
  type Call,
  type Condition,
} from "zodiac-roles-sdk";
import type { SdkState } from "./policy-codec";
import type { DraftPermission, PolicyIssue } from "./policy";
import { shortHex } from "./abi";

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
 * Risk of a single draft permission, for the editor's own display.
 *
 * Derived from the permission's structure — execution flags, clearance, whether
 * any parameter is actually constrained — never from a parameter's label, so
 * renaming a field cannot change the assessment.
 */
export function draftPermissionRisk(permission: DraftPermission): Risk {
  if (permission.delegatecall) return "Critical";
  if (permission.mode === "target") return "High";

  // An imported condition is real policy even though the editor cannot show it.
  if (permission.rawCondition) return "Medium";

  const constrained = permission.conditions.some(
    (condition) => condition.operator !== "pass",
  );
  if (!constrained) return "High";
  return permission.send ? "Medium" : "Low";
}

export function riskReason(permission: DraftPermission): string {
  if (permission.delegatecall) {
    return "Delegatecall runs the target's code with the Safe's own storage and balances.";
  }
  if (permission.mode === "target") {
    return "Whole-contract clearance permits every function, including ones added by a future upgrade.";
  }
  if (permission.rawCondition) {
    return "Deployed condition is preserved exactly as it is on chain and cannot be edited here.";
  }
  if (!permission.conditions.some((condition) => condition.operator !== "pass")) {
    return "No parameter is constrained, so any recipient or amount is permitted.";
  }
  if (permission.send) {
    return "The call may also send native value.";
  }
  return "Parameters are constrained.";
}

export type PlannedChange = {
  id: string;
  call: Call;
  action: "Grant" | "Restrict" | "Revoke" | "Budget" | "Membership" | "Metadata";
  /** Decoded role key, or "—" for modifier-wide calls. */
  scope: string;
  summary: string;
  detail: string;
  risk: Risk;
  /** Why this carries the risk it does. Shown next to the row. */
  rationale?: string;
};

export type EncodedTransaction = {
  to: string;
  value: string;
  data: string;
  /** Roles calls are always plain calls from the Safe. */
  operation: 0;
};

export type Plan = {
  calls: Call[];
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
        rationale: "Narrows the contract from whole-target clearance to specific functions.",
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
      const unconstrained = isUnconstrained(call.condition);
      const delegate = allowsDelegateCall(call.executionOptions);
      return {
        action: "Grant",
        scope: keyLabel(call.roleKey),
        summary: `Allow ${call.selector} on ${shortHex(call.targetAddress)} under conditions`,
        detail: `${call.targetAddress} · ${describeExecution(call.executionOptions)}`,
        risk: delegate ? "Critical" : unconstrained ? "High" : "Medium",
        rationale: delegate
          ? "Delegatecall runs the target's code with the Safe's own storage and balances."
          : unconstrained
            ? "Every parameter in this condition passes, so it constrains nothing."
            : "Parameters are constrained by the attached condition.",
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
    calls = callsPlannedForApply(current, desired);
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

  // The SDK planner currently ignores balance- and timestamp-only allowance
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
