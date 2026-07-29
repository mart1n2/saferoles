import {
  AbiCoder,
  Interface,
  encodeBytes32String,
  id,
  isAddress,
} from "ethers";

enum ExecutionOptions {
  None = 0,
  DelegateCall = 2,
}

enum ParameterType {
  None = 0,
  Static = 1,
  Dynamic = 2,
  Tuple = 3,
  Array = 4,
  Calldata = 5,
}

enum Operator {
  Pass = 0,
  Matches = 5,
  EqualToAvatar = 15,
  EqualTo = 16,
  WithinAllowance = 28,
}

type RolesCondition = {
  paramType: ParameterType;
  operator: Operator;
  compValue?: `0x${string}`;
  children?: readonly RolesCondition[];
};

const rolesAbi = [
  "function assignRoles(address module, bytes32[] roleKeys, bool[] memberOf)",
  "function allowTarget(bytes32 roleKey, address targetAddress, uint8 options)",
  "function revokeTarget(bytes32 roleKey, address targetAddress)",
  "function scopeTarget(bytes32 roleKey, address targetAddress)",
  "function allowFunction(bytes32 roleKey, address targetAddress, bytes4 selector, uint8 options)",
  "function revokeFunction(bytes32 roleKey, address targetAddress, bytes4 selector)",
  "function scopeFunction(bytes32 roleKey, address targetAddress, bytes4 selector, tuple(uint8 parent,uint8 paramType,uint8 operator,bytes compValue)[] conditions, uint8 options)",
  "function setAllowance(bytes32 key, uint128 balance, uint128 maxRefill, uint128 refill, uint64 period, uint64 timestamp)",
] as const;

export type PolicyMember = {
  address: string;
};

export type PolicyCondition = {
  index: number;
  operator: "Equal to" | "Equal to avatar" | "Within allowance" | "Pass";
  value: string;
};

export type PolicyPermission = {
  id: string;
  address: string;
  signature: string;
  mode: "Function" | "Target";
  execution: "Call" | "Delegate call";
  conditions: PolicyCondition[];
  allowance?: {
    key: string;
    amount: string;
    period: string;
    display?: string;
    periodLabel?: string;
  };
};

export type PolicyRole = {
  id: string;
  key: string;
  members: PolicyMember[];
  permissions: PolicyPermission[];
};

export type RolesTransaction = {
  to: string;
  value: string;
  data: string;
  operation: 0;
  label: string;
};

const rolesInterface = new Interface(rolesAbi);
const coder = AbiCoder.defaultAbiCoder();

function encodeKey(key: string) {
  if (key.startsWith("0x") && key.length === 66) return key;
  return encodeBytes32String(key);
}

function flattenCondition(root: RolesCondition) {
  const result: Array<{
    parent: number;
    paramType: ParameterType;
    operator: Operator;
    compValue?: `0x${string}`;
  }> = [];
  const queue: Array<{ condition: RolesCondition; parent: number }> = [
    { condition: root, parent: 0 },
  ];
  while (queue.length) {
    const current = queue.shift();
    if (!current) break;
    const { children, ...condition } = current.condition;
    result.push({ ...condition, parent: current.parent });
    const index = result.length - 1;
    for (const child of children ?? []) {
      queue.push({ condition: child, parent: index });
    }
  }
  return result;
}

function splitTypes(input: string) {
  const result: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of input) {
    if (character === "," && depth === 0) {
      result.push(current.trim());
      current = "";
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    current += character;
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

function signatureTypes(signature: string) {
  const start = signature.indexOf("(");
  const end = signature.lastIndexOf(")");
  if (start <= 0 || end < start) {
    throw new Error(`Invalid function signature: ${signature}`);
  }
  const input = signature.slice(start + 1, end);
  return input.trim() ? splitTypes(input) : [];
}

function parameterType(type: string): ParameterType {
  if (type.endsWith("]")) return ParameterType.Array;
  if (type === "bytes" || type === "string") return ParameterType.Dynamic;
  if (type.startsWith("(")) return ParameterType.Tuple;
  return ParameterType.Static;
}

function extractAddress(value: string) {
  const match = value.match(/0x[a-fA-F0-9]{40}/);
  return match?.[0];
}

function comparisonValue(type: string, condition: PolicyCondition) {
  if (condition.operator === "Equal to avatar" || condition.operator === "Pass") {
    return "0x";
  }
  if (condition.operator === "Within allowance") {
    return encodeKey(condition.value.trim());
  }

  let value: string | bigint = condition.value.trim();
  if (type === "address") {
    const address = extractAddress(value);
    if (!address) throw new Error(`Expected a full address, received "${value}"`);
    value = address;
  } else if (/^u?int\d*$/.test(type)) {
    value = BigInt(value.replaceAll(",", ""));
  } else if (type === "bool") {
    value = value === "true" ? "true" : "false";
  }
  return coder.encode([type], [value]);
}

function operator(value: PolicyCondition["operator"]) {
  return {
    "Equal to": Operator.EqualTo,
    "Equal to avatar": Operator.EqualToAvatar,
    "Within allowance": Operator.WithinAllowance,
    Pass: Operator.Pass,
  }[value];
}

function permissionConditions(permission: PolicyPermission) {
  const types = signatureTypes(permission.signature);
  const children: RolesCondition[] = types.map((type, index) => {
    const condition = permission.conditions.find((item) => item.index === index);
    if (!condition) {
      return {
        paramType: parameterType(type),
        operator: Operator.Pass,
      };
    }
    return {
      paramType: parameterType(type),
      operator: operator(condition.operator),
      compValue: comparisonValue(type, condition) as `0x${string}`,
    };
  });

  const root: RolesCondition = {
    paramType: ParameterType.Calldata,
    operator: Operator.Matches,
    children,
  };

  return flattenCondition(root).map((condition) => ({
    parent: condition.parent,
    paramType: condition.paramType,
    operator: condition.operator,
    compValue: condition.compValue ?? "0x",
  }));
}

function functionSelector(signature: string) {
  signatureTypes(signature);
  return id(signature).slice(0, 10);
}

function executionOptions(permission: PolicyPermission) {
  return permission.execution === "Delegate call"
    ? ExecutionOptions.DelegateCall
    : ExecutionOptions.None;
}

function same(valueA: unknown, valueB: unknown) {
  return JSON.stringify(valueA) === JSON.stringify(valueB);
}

function tx(
  rolesAddress: string,
  label: string,
  functionName: string,
  args: readonly unknown[],
): RolesTransaction {
  return {
    to: rolesAddress,
    value: "0",
    data: rolesInterface.encodeFunctionData(functionName, args),
    operation: 0,
    label,
  };
}

export function buildRolesTransactions({
  rolesAddress,
  baseline,
  desired,
}: {
  rolesAddress: string;
  baseline: PolicyRole[];
  desired: PolicyRole[];
}) {
  const transactions: RolesTransaction[] = [];
  const issues: string[] = [];
  const encodedAllowances = new Set<string>();

  if (!isAddress(rolesAddress)) {
    return {
      transactions,
      issues: ["Enter a complete Roles Modifier address."],
    };
  }

  for (const role of desired) {
    let roleKey: string;
    try {
      roleKey = encodeKey(role.key);
    } catch (error) {
      issues.push(
        `${role.key}: ${error instanceof Error ? error.message : "invalid role key"}`,
      );
      continue;
    }

    const previous = baseline.find((item) => item.id === role.id);
    const previousMembers = new Set(
      (previous?.members ?? []).map((member) => member.address.toLowerCase()),
    );
    const desiredMembers = new Set(
      role.members.map((member) => member.address.toLowerCase()),
    );

    for (const member of role.members) {
      if (previousMembers.has(member.address.toLowerCase())) continue;
      if (!isAddress(member.address)) {
        issues.push(`${role.key}: member ${member.address} is not a full address.`);
        continue;
      }
      transactions.push(
        tx(rolesAddress, `Assign ${role.key} to ${member.address}`, "assignRoles", [
          member.address,
          [roleKey],
          [true],
        ]),
      );
    }

    for (const member of previous?.members ?? []) {
      if (desiredMembers.has(member.address.toLowerCase())) continue;
      if (!isAddress(member.address)) {
        issues.push(`${role.key}: member ${member.address} is not a full address.`);
        continue;
      }
      transactions.push(
        tx(rolesAddress, `Revoke ${role.key} from ${member.address}`, "assignRoles", [
          member.address,
          [roleKey],
          [false],
        ]),
      );
    }

    for (const permission of role.permissions) {
      const allowance = permission.allowance;
      if (!allowance || encodedAllowances.has(allowance.key)) continue;
      const previousAllowance = previous?.permissions.find(
        (item) => item.allowance?.key === allowance.key,
      )?.allowance;
      if (previousAllowance && same(previousAllowance, allowance)) continue;
      if (!/^\d+$/.test(allowance.amount) || !/^\d+$/.test(allowance.period)) {
        issues.push(
          `${role.key}: allowance ${allowance.key} must use integer base units and seconds.`,
        );
        continue;
      }
      try {
        const balance = BigInt(allowance.amount);
        transactions.push(
          tx(rolesAddress, `Set allowance ${allowance.key}`, "setAllowance", [
            encodeKey(allowance.key),
            balance,
            balance,
            balance,
            BigInt(allowance.period),
            0,
          ]),
        );
        encodedAllowances.add(allowance.key);
      } catch (error) {
        issues.push(
          `${role.key}: ${
            error instanceof Error ? error.message : "cannot encode allowance"
          }`,
        );
      }
    }

    for (const permission of previous?.permissions ?? []) {
      if (role.permissions.some((item) => item.id === permission.id)) continue;
      if (!isAddress(permission.address)) {
        issues.push(
          `${role.key}: target ${permission.address} is not a full address.`,
        );
        continue;
      }
      try {
        transactions.push(
          permission.mode === "Target"
            ? tx(
                rolesAddress,
                `Revoke target ${permission.address}`,
                "revokeTarget",
                [roleKey, permission.address],
              )
            : tx(
                rolesAddress,
                `Revoke ${permission.signature}`,
                "revokeFunction",
                [roleKey, permission.address, functionSelector(permission.signature)],
              ),
        );
      } catch (error) {
        issues.push(
          `${role.key}: ${error instanceof Error ? error.message : "cannot encode revocation"}`,
        );
      }
    }

    for (const permission of role.permissions) {
      const previousPermission = previous?.permissions.find(
        (item) => item.id === permission.id,
      );
      if (previousPermission && same(previousPermission, permission)) continue;
      if (!isAddress(permission.address)) {
        issues.push(
          `${role.key}: target ${permission.address} is not a full address.`,
        );
        continue;
      }

      try {
        if (permission.mode === "Target") {
          transactions.push(
            tx(rolesAddress, `Allow target ${permission.address}`, "allowTarget", [
              roleKey,
              permission.address,
              executionOptions(permission),
            ]),
          );
          continue;
        }

        transactions.push(
          tx(rolesAddress, `Scope target ${permission.address}`, "scopeTarget", [
            roleKey,
            permission.address,
          ]),
        );

        const selector = functionSelector(permission.signature);
        transactions.push(
          permission.conditions.length === 0
            ? tx(
                rolesAddress,
                `Allow ${permission.signature}`,
                "allowFunction",
                [
                  roleKey,
                  permission.address,
                  selector,
                  executionOptions(permission),
                ],
              )
            : tx(
                rolesAddress,
                `Scope ${permission.signature}`,
                "scopeFunction",
                [
                  roleKey,
                  permission.address,
                  selector,
                  permissionConditions(permission),
                  executionOptions(permission),
                ],
              ),
        );
      } catch (error) {
        issues.push(
          `${role.key} · ${permission.signature}: ${
            error instanceof Error ? error.message : "cannot encode permission"
          }`,
        );
      }
    }
  }

  return { transactions, issues };
}
