/**
 * Permission patterns that are unsafe no matter what the role is meant to do.
 *
 * - A permission on the zero address. No contract lives there, so it never
 *   serves a purpose.
 * - A Morpho GeneralAdapter1 action whose `data` argument is not pinned to
 *   empty (0x). SafeRoles requires it to be pinned for these actions.
 * - A condition stored by a Roles SDK older than 4.1.5 for a function with
 *   fixed-size array parameters (`uint256[2]` and the like). SDK 4.1.5 changed
 *   how those are encoded (a tuple of k elements instead of a dynamic array);
 *   such conditions are offered for re-applying in the current encoding.
 *
 * The first two block a plan that would write them; permissions already on
 * chain are reported rather than blocked, so an unrelated urgent change (such
 * as revoking a member) is never held up by them.
 */
import { AbiCoder, id, ParamType } from "ethers";
import { encodeKey, Operator, ParameterType, type Condition } from "zodiac-roles-sdk";
import { shortHex, parseSignature } from "./abi";
import type { DraftPermission, DraftPolicy, PolicyIssue } from "./policy";
import { decodeFlatConditions, isAllPass, type SdkState } from "./policy-codec";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const MARKET_PARAMS = "(address,address,address,address,uint256)";
/** GeneralAdapter1 actions with a `data` argument, and its position. */
const MORPHO_CALLBACKS: ReadonlyMap<string, { name: string; dataIndex: number }> = new Map(
  ([
    [`morphoSupply(${MARKET_PARAMS},uint256,uint256,uint256,address,bytes)`, 5],
    [`morphoSupplyCollateral(${MARKET_PARAMS},uint256,address,bytes)`, 3],
    [`morphoRepay(${MARKET_PARAMS},uint256,uint256,uint256,address,bytes)`, 5],
    ["morphoFlashLoan(address,uint256,bytes)", 2],
  ] as const).map(([signature, dataIndex]) => [id(signature).slice(0, 10), { name: signature.slice(0, signature.indexOf("(")), dataIndex }]),
);

/** True for a condition that requires a `bytes` argument to be empty. */
export function isEmptyBytesCondition(condition: Condition | undefined): boolean {
  if (!condition || condition.operator !== Operator.EqualTo || condition.paramType !== ParameterType.Dynamic || !condition.compValue) return false;
  try {
    return AbiCoder.defaultAbiCoder().decode(["bytes"], condition.compValue)[0] === "0x";
  } catch {
    return false;
  }
}

/** The Morpho action a function permission leaves open, or null when it is not one or its `data` is pinned to empty. */
export function openMorphoCallback(selector: string, condition: Condition | undefined): string | null {
  const morpho = MORPHO_CALLBACKS.get(selector.toLowerCase());
  if (!morpho) return null;
  const matches = condition?.paramType === ParameterType.Calldata && condition.operator === Operator.Matches;
  return matches && isEmptyBytesCondition(condition.children?.[morpho.dataIndex]) ? null : morpho.name;
}

const isZero = (address: string) => address.toLowerCase() === ZERO_ADDRESS;

const zeroMessage = (target: string) =>
  `A permission targets ${shortHex(target)}, the zero address. No contract lives there, so the permission serves no purpose; remove it.`;
const morphoMessage = (name: string) =>
  `Morpho ${name} must have its data parameter set to equal 0x (empty). Pin it, or remove the permission.`;

type PlannedCall = { call: string; roleKey?: string; targetAddress?: string; selector?: string; condition?: Condition };

/**
 * Blocking issues for calls the plan would send. Each is attached to the draft
 * permission it comes from when that can be found, so review can jump to it.
 */
export function plannedCallIssues(calls: readonly PlannedCall[], policy: DraftPolicy | null): PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  for (const call of calls) {
    if (!call.targetAddress || call.call === "revokeTarget" || call.call === "revokeFunction") continue;
    const where = locate(policy, call);
    if (isZero(call.targetAddress)) {
      issues.push({ ...where, message: zeroMessage(call.targetAddress) });
      continue;
    }
    if ((call.call === "allowFunction" || call.call === "scopeFunction") && call.selector) {
      const open = openMorphoCallback(call.selector, call.call === "scopeFunction" ? call.condition : undefined);
      if (open) issues.push({ ...where, message: morphoMessage(open) });
    }
  }
  return issues;
}

/** The same patterns in permissions already on chain, for a warning that blocks nothing. */
export function standingWarnings(state: SdkState | null): string[] {
  if (!state) return [];
  const warnings: string[] = [];
  for (const role of state.roles) {
    for (const target of role.targets) {
      if (isZero(target.address) && target.clearance !== 0) warnings.push(zeroMessage(target.address));
      if (target.clearance === 0) continue;
      for (const fn of target.functions) {
        const open = openMorphoCallback(fn.selector, fn.wildcarded ? undefined : fn.condition);
        if (open) warnings.push(morphoMessage(open));
      }
    }
  }
  return [...new Set(warnings)];
}

const isFixedArray = (type: ParamType) => type.baseType === "array" && type.arrayLength !== null && type.arrayLength >= 0;

/**
 * Where a stored condition describes a fixed-size array parameter the way SDKs
 * before 4.1.5 did (a dynamic Array node instead of a tuple of k elements).
 * `fixable` when every such part leaves the array unconstrained, so the
 * condition can be rebuilt exactly by the current SDK.
 */
export function legacyFixedArrays(condition: Condition, params: readonly ParamType[]): { found: boolean; fixable: boolean } {
  let found = false;
  let fixable = true;
  const walk = (node: Condition | undefined, type: ParamType | undefined) => {
    if (!node || !type) return;
    if (isFixedArray(type) && node.paramType === ParameterType.Array) {
      found = true;
      if (!isAllPass(node)) fixable = false;
      return;
    }
    const children = node.children ?? [];
    if (type.baseType === "tuple") children.forEach((child, index) => walk(child, type.components?.[index]));
    else if (type.baseType === "array") children.forEach((child) => walk(child, type.arrayChildren ?? undefined));
    else children.forEach((child) => walk(child, type));
  };
  if (condition.paramType === ParameterType.Calldata && condition.operator === Operator.Matches) {
    condition.children?.forEach((child, index) => walk(child, params[index]));
  } else {
    // Logical wrappers (And, Or) around the calldata match.
    const visit = (node: Condition) => {
      if (node.paramType === ParameterType.Calldata && node.operator === Operator.Matches) node.children?.forEach((child, index) => walk(child, params[index]));
      else node.children?.forEach(visit);
    };
    visit(condition);
  }
  return { found, fixable: found && fixable };
}

/** The legacy check for a draft permission, when its signature is known. */
export function legacyEncoding(permission: DraftPermission): { found: boolean; fixable: boolean } {
  if (!permission.rawCondition || !permission.signature.trim()) return { found: false, fixable: false };
  try {
    return legacyFixedArrays(permission.rawCondition, parseSignature(permission.signature).params);
  } catch {
    return { found: false, fixable: false };
  }
}

/**
 * The permission rebuilt for the current SDK: the stored condition as flat
 * conditions, with unconstrained parts left out (the encoder describes them
 * from the signature). Null when the condition cannot be expressed that way.
 */
export function reencodePermission(permission: DraftPermission): DraftPermission | null {
  if (!permission.rawCondition || !permission.signature.trim()) return null;
  const { params } = parseSignature(permission.signature);
  const conditions = decodeFlatConditions(permission.rawCondition, params, { passSubtrees: true });
  return conditions ? { ...permission, conditions, rawCondition: undefined } : null;
}

function locate(policy: DraftPolicy | null, call: PlannedCall): Pick<PolicyIssue, "roleId" | "permissionId"> {
  if (!policy || !call.roleKey) return {};
  for (const role of policy.roles) {
    let key: string;
    try {
      key = (role.deployedKey ?? encodeKey(role.key.trim())).toLowerCase();
    } catch {
      continue;
    }
    if (key !== call.roleKey.toLowerCase()) continue;
    const permission = role.permissions.find((candidate) => {
      if (candidate.targetAddress.trim().toLowerCase() !== call.targetAddress?.toLowerCase()) return false;
      if (!call.selector) return candidate.mode === "target";
      try {
        const selector = candidate.selector ?? parseSignature(candidate.signature).selector;
        return selector.toLowerCase() === call.selector.toLowerCase();
      } catch {
        return false;
      }
    });
    return { roleId: role.id, permissionId: permission?.id };
  }
  return {};
}
