/**
 * Converts between the draft policy model and the Zodiac Roles SDK's state.
 *
 * All calldata-bearing encoding is delegated to the SDK, which owns Roles v2
 * correctness (condition trees for tuples and arrays, comparison-value packing,
 * clearance transitions). This module's job is mapping, validation, and
 * reporting problems against the specific field that caused them.
 */
import { AbiCoder, ParamType } from "ethers";
import {
  Operator,
  ParameterType,
  c,
  encodeKey,
  decodeKey,
  processPermissions,
  reconstructPermissions,
  targetIntegrity,
  type Allowance as SdkAllowance,
  type Condition,
  type Permission,
  type Role as SdkRole,
  type RolesModifier,
  type Target as SdkTarget,
} from "zodiac-roles-sdk";
import { isNumericType, parseSignature, parseValue, signatureMatchesSelector } from "./abi";
import type {
  DraftAllowance,
  DraftCondition,
  DraftPermission,
  DraftPolicy,
  DraftRole,
  PolicyIssue,
} from "./policy";

const coder = AbiCoder.defaultAbiCoder();

/** A condition function as produced by the SDK's `c` builders. */
type Scoping = ReturnType<typeof c.eq> | undefined;

function buildScoping(
  condition: DraftCondition,
  param: ParamType,
): Scoping {
  switch (condition.operator) {
    case "pass":
      return undefined;
    case "avatar":
      return c.avatar;
    case "eq":
      return c.eq(parseValue(param, condition.value));
    case "withinAllowance":
      return c.withinAllowance(encodeKey(condition.value.trim()));
    case "gt":
      return c.gt(parseValue(param, condition.value) as bigint);
    case "gte":
      return c.gte(parseValue(param, condition.value) as bigint);
    case "lt":
      return c.lt(parseValue(param, condition.value) as bigint);
    case "lte":
      return c.lte(parseValue(param, condition.value) as bigint);
  }
}

function validateOperatorAgainstType(
  condition: DraftCondition,
  param: ParamType,
): string | null {
  const { operator } = condition;
  if (operator === "avatar" && param.baseType !== "address") {
    return `${param.type} cannot be compared to the avatar; that operator applies to address parameters.`;
  }
  if (
    (operator === "gt" ||
      operator === "gte" ||
      operator === "lt" ||
      operator === "lte" ||
      operator === "withinAllowance") &&
    !isNumericType(param.baseType)
  ) {
    return `${param.type} is not numeric, so "${operator}" cannot apply to it.`;
  }
  if (
    operator === "gte" &&
    param.baseType.startsWith("uint") &&
    /^0+$/.test(condition.value.trim())
  ) {
    return `"At least 0" is always true for ${param.type} and constrains nothing. Remove the condition or raise the bound.`;
  }
  return null;
}

/**
 * Builds the SDK permission for one draft permission.
 *
 * @throws with a human-readable message; callers convert it into a
 *         {@link PolicyIssue} against this permission.
 */
function toPermission(permission: DraftPermission): Permission {
  // Validated, not merely cast: a mistyped or truncated target would otherwise
  // reach the encoder and grant permission on the wrong contract. `isAddress`
  // accepts all-lowercase (as the indexer returns) and rejects mixed case with a
  // bad checksum, which only happens when an address has been corrupted.
  const targetAddress = parseValue(
    ParamType.from("address"),
    permission.targetAddress,
  ) as `0x${string}`;
  const flags = { send: permission.send, delegatecall: permission.delegatecall };

  if (permission.mode === "target") {
    return { targetAddress, ...flags };
  }

  // An imported permission is identified by the selector the modifier actually
  // stores. It is used whenever present — including for a wildcarded function,
  // which has a selector and no condition — because requiring a signature here
  // would make the permission unencodable and drop it out of the desired state.
  if (permission.selector && !permission.signature.trim()) {
    return {
      targetAddress,
      selector: permission.selector as `0x${string}`,
      ...(permission.rawCondition ? { condition: permission.rawCondition } : {}),
      ...flags,
    };
  }

  // A condition imported from chain that the flat editor cannot represent is
  // passed through byte-for-byte rather than approximated.
  if (permission.rawCondition) {
    const selector = (permission.selector ??
      parseSignature(permission.signature).selector) as `0x${string}`;
    return { targetAddress, selector, condition: permission.rawCondition, ...flags };
  }

  const { selector, params, canonical } = parseSignature(permission.signature);

  const outOfRange = permission.conditions.filter(
    (condition) => condition.paramIndex >= params.length,
  );
  if (outOfRange.length > 0) {
    const positions = outOfRange.map((condition) => condition.paramIndex).join(", ");
    throw new Error(
      `${canonical} takes ${params.length} parameter${params.length === 1 ? "" : "s"} (0-${Math.max(params.length - 1, 0)}), so position${outOfRange.length === 1 ? "" : "s"} ${positions} cannot be constrained.`,
    );
  }

  const active = permission.conditions.filter(
    (condition) => condition.operator !== "pass",
  );
  if (active.length === 0) {
    // No parameter constraints: the whole function is allowed.
    return { targetAddress, selector: selector as `0x${string}`, ...flags };
  }

  const scopings: Scoping[] = params.map((param, index) => {
    const forParam = active.filter((condition) => condition.paramIndex === index);
    if (forParam.length === 0) return undefined;

    for (const condition of forParam) {
      const problem = validateOperatorAgainstType(condition, param);
      if (problem) throw new Error(problem);
    }

    const built = forParam
      .map((condition) => buildScoping(condition, param))
      .filter((scoping): scoping is NonNullable<Scoping> => Boolean(scoping));

    if (built.length === 0) return undefined;
    if (built.length === 1) return built[0];
    // Several conditions on one parameter must all hold. Composing them is what
    // keeps a duplicate position from being silently dropped.
    return c.and(...(built as [NonNullable<Scoping>, NonNullable<Scoping>]));
  });

  return {
    targetAddress,
    selector: selector as `0x${string}`,
    condition: c.calldataMatches(scopings, params as readonly ParamType[]),
    ...flags,
  };
}

function toSdkAllowance(allowance: DraftAllowance): SdkAllowance {
  const key = allowance.key.trim();
  if (!key) {
    // `encodeKey("")` is a valid bytes32 of zeros, so an unnamed allowance would
    // silently write a zero-key budget rather than failing.
    throw new Error("give the allowance a key so conditions can reference it.");
  }

  const amount = (field: keyof DraftAllowance, label: string) => {
    const raw = String(allowance[field] ?? "").trim().replaceAll(",", "").replaceAll("_", "");
    if (!/^\d+$/.test(raw)) {
      throw new Error(`${label} must be a whole number in base units.`);
    }
    return BigInt(raw);
  };

  const maxRefill = amount("maxRefill", "Maximum refill");
  const balance = amount("balance", "Available balance");
  const refill = amount("refill", "Refill amount");
  const period = amount("period", "Period");

  if (balance > maxRefill) {
    throw new Error(
      "Available balance cannot exceed the maximum refill, which is the ceiling the allowance tops up to.",
    );
  }
  if (period === 0n && refill > 0n) {
    throw new Error(
      "A refill amount needs a non-zero period. Set a period, or set the refill to 0 for a one-time budget.",
    );
  }

  return {
    key: encodeKey(key),
    balance,
    maxRefill,
    refill,
    period,
    timestamp: amount("timestamp", "Refill window start"),
  };
}

export type SdkState = {
  roles: SdkRole[];
  allowances: SdkAllowance[];
};

/**
 * Maps the whole draft policy into SDK state, collecting every validation
 * problem instead of failing on the first one, so the review screen can show
 * all of them at once.
 *
 * A role that produces issues is omitted from the returned state — planning
 * against a partially-encoded role would compute the wrong diff.
 */
export function toSdkState(policy: DraftPolicy): {
  state: SdkState;
  issues: PolicyIssue[];
} {
  const issues: PolicyIssue[] = [];
  const roles: SdkRole[] = [];
  // Role identity on chain is the encoded key, not the local id or the name. Two
  // roles sharing a key are one role, and the planner keeps only one of them —
  // silently discarding the other's members and permissions.
  const keyOwners = new Map<string, DraftRole[]>();

  for (const role of policy.roles) {
    const roleIssues: PolicyIssue[] = [];

    let key: `0x${string}` | null = null;
    const trimmedKey = role.key.trim();
    if (!trimmedKey) {
      roleIssues.push({
        roleId: role.id,
        message: `${role.name || "This role"} has no key. A role is addressed on chain by its key, and an empty one encodes to all zeros.`,
      });
    }
    try {
      key = encodeKey(trimmedKey);
    } catch (error) {
      roleIssues.push({
        roleId: role.id,
        message: `Role key "${role.key}": ${describe(error, "cannot be encoded as bytes32. Keys are limited to 31 bytes.")}`,
      });
    }

    const members: `0x${string}`[] = [];
    const seenMembers = new Set<string>();
    for (const member of role.members) {
      try {
        const address = parseValue(
          ParamType.from("address"),
          member.address,
        ) as `0x${string}`;
        // The same address listed twice would emit two identical assignRoles
        // calls. Collapsing them changes nothing on chain and costs less gas.
        if (seenMembers.has(address.toLowerCase())) continue;
        seenMembers.add(address.toLowerCase());
        members.push(address);
      } catch (error) {
        roleIssues.push({
          roleId: role.id,
          memberId: member.id,
          message: `Member ${member.label ? `"${member.label}" ` : ""}${describe(error, "is not a valid address.")}`,
        });
      }
    }

    const permissions: Permission[] = [];
    for (const permission of role.permissions) {
      try {
        permissions.push(toPermission(permission));
      } catch (error) {
        roleIssues.push({
          roleId: role.id,
          permissionId: permission.id,
          message: `${permission.name || permission.targetAddress || "Permission"}: ${describe(error, "cannot be encoded.")}`,
        });
      }
    }

    // Clearing a whole contract subsumes any function-level permission on it.
    // The SDK resolves this to full access with only a console warning, so a
    // narrow permission would appear in the editor while the proposal granted
    // everything.
    for (const [address, group] of groupByAddress(role.permissions)) {
      const wholeContract = group.find((entry) => entry.mode === "target");
      const scoped = group.filter((entry) => entry.mode === "function");
      if (wholeContract && scoped.length > 0) {
        roleIssues.push({
          roleId: role.id,
          permissionId: scoped[0].id,
          message: `${role.name || role.key}: "${wholeContract.name || address}" clears the entire contract, which already permits ${scoped
            .map((entry) => entry.signature || entry.selector || "its functions")
            .join(", ")}. Remove the whole-contract permission, or the narrower ones it makes redundant — as written this grants every function.`,
        });
      }
    }

    if (roleIssues.length > 0 || !key) {
      issues.push(...roleIssues);
      continue;
    }

    keyOwners.set(key, [...(keyOwners.get(key) ?? []), role]);

    try {
      const { targets, annotations } = processPermissions(permissions);
      // The SDK's integrity check mirrors the modifier's own Integrity.sol.
      // Running it here turns an on-chain revert — discovered only after
      // owners have signed — into a blocking pre-flight issue.
      targetIntegrity(targets);
      roles.push({
        key,
        members,
        targets: withResidualTargets(targets, role.residualTargets),
        // Annotations the role already carries are preserved unless the draft
        // itself defines them.
        annotations: role.annotations ?? annotations,
        lastUpdate: 0,
      });
    } catch (error) {
      issues.push({
        roleId: role.id,
        message: `${role.name}: ${describe(error, "produced an invalid permission set.")}`,
      });
    }
  }

  for (const [key, owners] of keyOwners) {
    if (owners.length < 2) continue;
    const names = owners.map((role) => `"${role.name || role.key}"`).join(", ");
    for (const role of owners) {
      issues.push({
        roleId: role.id,
        message: `${names} all use the role key "${safeDecodeKey(key as `0x${string}`)}". A role is identified on chain by its key, so these are one role — only one would survive and the others' members and permissions would be dropped. Give each a distinct key.`,
      });
    }
  }

  const allowances: SdkAllowance[] = [];
  const seenKeys = new Map<string, string>();
  for (const allowance of policy.allowances) {
    try {
      const encoded = toSdkAllowance(allowance);
      const previous = seenKeys.get(encoded.key);
      if (previous) {
        throw new Error(
          `duplicates the key already used by "${previous}". Allowance keys are unique across the modifier.`,
        );
      }
      seenKeys.set(encoded.key, allowance.key);
      allowances.push(encoded);
    } catch (error) {
      issues.push({
        allowanceId: allowance.id,
        message: `Allowance "${allowance.key}": ${describe(error, "is invalid.")}`,
      });
    }
  }

  // Every `withinAllowance` condition must reference an allowance that exists,
  // or the permission is unusable once deployed.
  const definedKeys = new Set(allowances.map((allowance) => allowance.key));
  for (const role of policy.roles) {
    for (const permission of role.permissions) {
      for (const condition of permission.conditions) {
        if (condition.operator !== "withinAllowance") continue;
        let encoded: `0x${string}`;
        try {
          encoded = encodeKey(condition.value.trim());
        } catch {
          continue; // already reported by toPermission
        }
        if (!definedKeys.has(encoded)) {
          issues.push({
            roleId: role.id,
            permissionId: permission.id,
            conditionId: condition.id,
            message: `${permission.name || permission.targetAddress}: allowance "${condition.value}" is referenced but not defined.`,
          });
        }
      }
    }
  }

  return { state: { roles, allowances }, issues };
}

function describe(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Groups a role's permissions by the contract they target. */
function groupByAddress(
  permissions: readonly DraftPermission[],
): Map<string, DraftPermission[]> {
  const groups = new Map<string, DraftPermission[]>();
  for (const permission of permissions) {
    const address = permission.targetAddress.trim().toLowerCase();
    if (!address) continue;
    groups.set(address, [...(groups.get(address) ?? []), permission]);
  }
  return groups;
}

/**
 * Re-adds preserved target rows for addresses the permission model did not
 * produce, so untouched on-chain state is not incidentally revoked.
 */
function withResidualTargets(
  targets: SdkTarget[],
  residual: SdkTarget[] | undefined,
): SdkTarget[] {
  if (!residual || residual.length === 0) return targets;
  const produced = new Set(targets.map((target) => target.address.toLowerCase()));
  const extra = residual.filter(
    (target) => !produced.has(target.address.toLowerCase()),
  );
  return extra.length === 0 ? targets : [...targets, ...extra];
}

/* -------------------------------------------------------------------------- */
/*                        Importing on-chain state                            */
/* -------------------------------------------------------------------------- */

let counter = 0;
function localId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/**
 * Converts the fetched modifier state into an editable draft.
 *
 * Function permissions arrive with a selector but no signature, because the
 * modifier stores only the selector. Conditions are therefore kept as
 * {@link DraftPermission.rawCondition} until a matching signature is adopted —
 * their comparison values cannot be decoded without knowing the parameter
 * types.
 */
export function fromRolesMod(mod: RolesModifier, chainId: number): DraftPolicy {
  const roles: DraftRole[] = mod.roles.map((role) => {
    const key = safeDecodeKey(role.key);
    const reconstructed = reconstructPermissions(role.targets);

    // Whatever the permission model cannot reproduce is kept verbatim. Computed
    // by round-tripping rather than by special-casing known shapes, so any
    // reconstruction gap is preserved rather than silently revoked.
    let residualTargets: SdkTarget[] | undefined;
    try {
      const reproduced = new Set(
        processPermissions(reconstructed).targets.map((target) =>
          target.address.toLowerCase(),
        ),
      );
      const missing = role.targets.filter(
        (target) => !reproduced.has(target.address.toLowerCase()),
      );
      if (missing.length > 0) residualTargets = missing;
    } catch {
      // If the round-trip cannot be computed, keep every target row.
      residualTargets = role.targets;
    }

    return {
      id: localId("role"),
      key,
      name: key,
      description: "",
      annotations: role.annotations,
      residualTargets,
      members: role.members.map((address) => ({
        id: localId("member"),
        address,
      })),
      permissions: reconstructed.map((permission) => {
        const shared = {
          id: localId("permission"),
          name: "",
          targetAddress: permission.targetAddress,
          send: Boolean(permission.send),
          delegatecall: Boolean(permission.delegatecall),
          conditions: [] as DraftCondition[],
        };
        if (!("selector" in permission)) {
          return { ...shared, mode: "target" as const, signature: "" };
        }
        return {
          ...shared,
          mode: "function" as const,
          signature: "",
          selector: permission.selector,
          rawCondition: permission.condition,
        };
      }),
    };
  });

  return {
    chainId,
    rolesMod: mod.address,
    roles,
    allowances: mod.allowances.map((allowance) => ({
      id: localId("allowance"),
      key: safeDecodeKey(allowance.key),
      balance: allowance.balance.toString(),
      maxRefill: allowance.maxRefill.toString(),
      refill: allowance.refill.toString(),
      period: allowance.period.toString(),
      timestamp: allowance.timestamp.toString(),
    })),
  };
}

function safeDecodeKey(key: `0x${string}`): string {
  try {
    const decoded = decodeKey(key);
    // Keep the raw bytes32 when it does not decode to readable text.
    return /^[\x20-\x7e]+$/.test(decoded) ? decoded : key;
  } catch {
    return key;
  }
}

/* -------------------------------------------------------------------------- */
/*                       Adopting a signature on import                       */
/* -------------------------------------------------------------------------- */

export type AdoptResult = {
  permission: DraftPermission;
  /** True when the condition tree became fully editable. */
  editable: boolean;
  note?: string;
};

/**
 * Attaches a signature to an imported permission.
 *
 * The signature must hash to the stored selector. When the stored condition
 * tree maps cleanly onto the flat editor it is decoded and `rawCondition` is
 * dropped; otherwise the raw tree is retained and the permission stays
 * read-only, so a policy is never rewritten into something weaker than what is
 * deployed.
 */
export function adoptSignature(
  permission: DraftPermission,
  signature: string,
): AdoptResult {
  const selector = permission.selector;
  if (!selector) {
    return { permission, editable: false, note: "This permission has no stored selector." };
  }
  if (!signatureMatchesSelector(signature, selector)) {
    return {
      permission,
      editable: false,
      note: `"${signature.trim()}" does not hash to ${selector}. The signature must match the selector stored on chain.`,
    };
  }

  const { params, canonical, readable } = parseSignature(signature);
  const decoded = permission.rawCondition
    ? decodeFlatConditions(permission.rawCondition, params)
    : [];

  if (!decoded) {
    return {
      permission: { ...permission, signature: canonical, signatureLabel: readable },
      editable: false,
      note: "The deployed condition uses nesting or operators this editor cannot represent. It is preserved exactly as deployed and stays read-only.",
    };
  }

  return {
    permission: {
      ...permission,
      signature: canonical,
      signatureLabel: readable,
      conditions: decoded,
      rawCondition: undefined,
    },
    editable: true,
  };
}

/**
 * Attempts to express a stored condition tree as flat per-parameter conditions.
 *
 * Returns `null` — meaning "keep the raw tree" — for anything the flat model
 * cannot hold exactly.
 */
function decodeFlatConditions(
  condition: Condition,
  params: readonly ParamType[],
): DraftCondition[] | null {
  if (
    condition.paramType !== ParameterType.Calldata ||
    condition.operator !== Operator.Matches ||
    !condition.children
  ) {
    return null;
  }
  if (condition.children.length > params.length) return null;

  const result: DraftCondition[] = [];
  for (const [index, child] of condition.children.entries()) {
    const param = params[index];
    if (child.children && child.children.length > 0) return null;

    switch (child.operator) {
      case Operator.Pass:
        continue;
      case Operator.EqualToAvatar:
        result.push({ id: localId("condition"), paramIndex: index, operator: "avatar", value: "" });
        continue;
      case Operator.EqualTo: {
        const value = decodeCompValue(child.compValue, param);
        if (value === null) return null;
        result.push({ id: localId("condition"), paramIndex: index, operator: "eq", value });
        continue;
      }
      case Operator.WithinAllowance: {
        if (!child.compValue) return null;
        result.push({
          id: localId("condition"),
          paramIndex: index,
          operator: "withinAllowance",
          value: safeDecodeKey(child.compValue),
        });
        continue;
      }
      case Operator.GreaterThan:
      case Operator.LessThan: {
        const value = decodeCompValue(child.compValue, param);
        if (value === null) return null;
        result.push({
          id: localId("condition"),
          paramIndex: index,
          // Stored bounds are strict. `gte`/`lte` are authoring shorthands the
          // SDK compiles to strict bounds, so they are shown as stored rather
          // than guessed back — same policy, no invented ambiguity.
          operator: child.operator === Operator.GreaterThan ? "gt" : "lt",
          value,
        });
        continue;
      }
      default:
        return null;
    }
  }
  return result;
}

function decodeCompValue(
  compValue: `0x${string}` | undefined,
  param: ParamType,
): string | null {
  if (!compValue) return null;
  try {
    const [decoded] = coder.decode([param], compValue);
    if (typeof decoded === "bigint") return decoded.toString();
    if (typeof decoded === "string" || typeof decoded === "boolean") {
      return String(decoded);
    }
    return JSON.stringify(decoded, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
  } catch {
    return null;
  }
}
