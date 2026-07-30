/**
 * Bounded JSON transport and persistence wire validation.
 *
 * Drafts are intentionally allowed to contain semantically-invalid field values:
 * they are work in progress and the policy planner reports those issues. Their
 * structure, scope and size are nevertheless validated here so an API caller
 * cannot persist arbitrary JSON and make later readers crash.
 */
import { getAddress, isAddress } from "ethers";
import type { Call, Condition } from "zodiac-roles-sdk";
import type {
  ConditionOperator,
  DraftPolicy,
  DraftRole,
} from "./policy";

const TAG = "$bigint";
const MAX_BIGINT_DIGITS = 78; // uint256
const MAX_REVIVE_DEPTH = 64;

export const MAX_DRAFT_BODY_BYTES = 2_000_000;
export const MAX_PROPOSAL_BODY_BYTES = 1_000_000;
export const MAX_ABI_BODY_BYTES = 2_000_000;

const MAX_ROLES = 128;
const MAX_TOTAL_MEMBERS = 4_096;
const MAX_TOTAL_PERMISSIONS = 4_096;
const MAX_TOTAL_CONDITIONS = 8_192;
const MAX_ALLOWANCES = 512;
const MAX_CALLS = 2_048;
const MAX_CONDITION_DEPTH = 32;
const MAX_CONDITION_NODES = 8_192;

type Tagged = { [TAG]: string };
type JsonRecord = Record<string, unknown>;

export class InputError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "InputError";
    this.status = status;
  }
}

function fail(path: string, message: string): never {
  throw new InputError(`${path} ${message}.`);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): JsonRecord {
  if (!isRecord(value)) fail(path, "must be an object");
  return value;
}

function exactKeys(
  value: JsonRecord,
  allowed: readonly string[],
  path: string,
): void {
  const allow = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allow.has(key));
  if (unexpected) fail(`${path}.${unexpected}`, "is not a supported field");
}

function stringValue(
  value: unknown,
  path: string,
  maxLength: number,
  options: { nonempty?: boolean } = {},
): string {
  if (typeof value !== "string") fail(path, "must be a string");
  if (value.length > maxLength) fail(path, `must be at most ${maxLength} characters`);
  if (options.nonempty && !value.trim()) fail(path, "must not be empty");
  return value;
}

function nullableString(
  value: unknown,
  path: string,
  maxLength: number,
): string | null | undefined {
  if (value === undefined || value === null) return value;
  return stringValue(value, path, maxLength);
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

function integer(
  value: unknown,
  path: string,
  min: number,
  max: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    fail(path, `must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function arrayValue(
  value: unknown,
  path: string,
  maxLength: number,
): unknown[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  if (value.length > maxLength) fail(path, `must contain at most ${maxLength} entries`);
  return value;
}

function address(value: unknown, path: string): string {
  const candidate = stringValue(value, path, 42, { nonempty: true });
  if (!isAddress(candidate)) fail(path, "must be a complete address");
  return getAddress(candidate);
}

function boundedDraftText(value: unknown, path: string, maxLength = 16_384): string {
  return stringValue(value, path, maxLength);
}

function optionalId(value: unknown, path: string, prefix: string): string | null {
  if (value === undefined || value === null) return null;
  const candidate = stringValue(value, path, 80, { nonempty: true });
  if (!new RegExp(`^${prefix}_[0-9a-f-]{36}$`, "i").test(candidate)) {
    fail(path, `must be a ${prefix} id`);
  }
  return candidate;
}

function baseStateHash(value: unknown, path: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  const candidate = stringValue(value, path, 64);
  if (!/^[0-9a-f]{64}$/i.test(candidate)) fail(path, "must be a SHA-256 hex digest");
  return candidate.toLowerCase();
}

export function parseChainId(value: unknown, path = "chainId"): number {
  return integer(value, path, 1, Number.MAX_SAFE_INTEGER);
}

export function parseAddress(value: unknown, path: string): string {
  return address(value, path);
}

export function parseAbiScope(url: URL): { chainId: number; address: string } {
  const chainRaw = url.searchParams.get("chainId");
  const addressRaw = url.searchParams.get("address");
  if (chainRaw === null || addressRaw === null) {
    throw new InputError("Provide chainId and address.");
  }
  return {
    chainId: parseChainId(Number(chainRaw)),
    address: address(addressRaw, "address"),
  };
}

export async function parseJsonRequest(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new InputError("Content-Type must be application/json.", 415);
  }

  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) {
    throw new InputError(`JSON body exceeds the ${maxBytes}-byte limit.`, 413);
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new InputError(`JSON body exceeds the ${maxBytes}-byte limit.`, 413);
  }
  if (!text.trim()) throw new InputError("Expected a JSON body.");

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InputError("Expected a valid JSON body.");
  }
}

function parseAnnotation(value: unknown, path: string): { uri: string; schema: string } {
  const item = record(value, path);
  exactKeys(item, ["uri", "schema"], path);
  return {
    uri: stringValue(item.uri, `${path}.uri`, 4_096, { nonempty: true }),
    schema: stringValue(item.schema, `${path}.schema`, 16_384),
  };
}

type ConditionBudget = { nodes: number };

function parseCondition(
  value: unknown,
  path: string,
  depth: number,
  budget: ConditionBudget,
): Condition {
  if (depth > MAX_CONDITION_DEPTH) fail(path, "is nested too deeply");
  budget.nodes += 1;
  if (budget.nodes > MAX_CONDITION_NODES) fail(path, "contains too many condition nodes");

  const item = record(value, path);
  exactKeys(item, ["paramType", "operator", "compValue", "children"], path);
  const result: {
    paramType: number;
    operator: number;
    compValue?: `0x${string}`;
    children?: Condition[];
  } = {
    paramType: integer(item.paramType, `${path}.paramType`, 0, 255),
    operator: integer(item.operator, `${path}.operator`, 0, 255),
  };

  if (item.compValue !== undefined) {
    const compValue = stringValue(item.compValue, `${path}.compValue`, 131_074);
    if (!/^0x(?:[0-9a-f]{2})*$/i.test(compValue)) {
      fail(`${path}.compValue`, "must be even-length hex");
    }
    result.compValue = compValue as `0x${string}`;
  }
  if (item.children !== undefined) {
    result.children = arrayValue(item.children, `${path}.children`, 1_024).map(
      (child, index) => parseCondition(child, `${path}.children[${index}]`, depth + 1, budget),
    );
  }
  return result as Condition;
}

function parseResidualTarget(value: unknown, path: string): NonNullable<DraftRole["residualTargets"]>[number] {
  const item = record(value, path);
  exactKeys(item, ["address", "clearance", "executionOptions", "functions"], path);
  const budget = { nodes: 0 };
  return {
    address: address(item.address, `${path}.address`) as `0x${string}`,
    clearance: integer(item.clearance, `${path}.clearance`, 0, 255),
    executionOptions: integer(item.executionOptions, `${path}.executionOptions`, 0, 255),
    functions: arrayValue(item.functions, `${path}.functions`, 2_048).map((entry, index) => {
      const fnPath = `${path}.functions[${index}]`;
      const fn = record(entry, fnPath);
      exactKeys(fn, ["selector", "executionOptions", "wildcarded", "condition"], fnPath);
      const selector = stringValue(fn.selector, `${fnPath}.selector`, 10);
      if (!/^0x[0-9a-f]{8}$/i.test(selector)) fail(`${fnPath}.selector`, "must be bytes4 hex");
      return {
        selector: selector as `0x${string}`,
        executionOptions: integer(fn.executionOptions, `${fnPath}.executionOptions`, 0, 255),
        wildcarded: booleanValue(fn.wildcarded, `${fnPath}.wildcarded`),
        ...(fn.condition === undefined
          ? {}
          : { condition: parseCondition(fn.condition, `${fnPath}.condition`, 0, budget) }),
      };
    }),
  } as NonNullable<DraftRole["residualTargets"]>[number];
}

const CONDITION_OPERATORS = new Set<ConditionOperator>([
  "pass",
  "eq",
  "avatar",
  "withinAllowance",
  "gt",
  "gte",
  "lt",
  "lte",
]);

export function parseDraftPolicy(
  value: unknown,
  expected: { chainId: number; rolesMod: string },
): DraftPolicy {
  const policy = record(value, "policy");
  exactKeys(policy, ["chainId", "rolesMod", "roles", "allowances"], "policy");

  const chainId = parseChainId(policy.chainId, "policy.chainId");
  const rolesMod = address(policy.rolesMod, "policy.rolesMod");
  if (chainId !== expected.chainId || rolesMod.toLowerCase() !== expected.rolesMod.toLowerCase()) {
    fail("policy", "scope must match the draft chainId and rolesMod");
  }

  let memberCount = 0;
  let permissionCount = 0;
  let conditionCount = 0;
  const roleIds = new Set<string>();

  const roles = arrayValue(policy.roles, "policy.roles", MAX_ROLES).map((entry, roleIndex) => {
    const path = `policy.roles[${roleIndex}]`;
    const role = record(entry, path);
    exactKeys(
      role,
      [
        "id",
        "key",
        "name",
        "description",
        "members",
        "permissions",
        "annotations",
        "residualTargets",
      ],
      path,
    );

    const id = stringValue(role.id, `${path}.id`, 128, { nonempty: true });
    if (roleIds.has(id)) fail(`${path}.id`, "must be unique");
    roleIds.add(id);

    const memberIds = new Set<string>();
    const members = arrayValue(role.members, `${path}.members`, MAX_TOTAL_MEMBERS).map(
      (memberValue, memberIndex) => {
        memberCount += 1;
        if (memberCount > MAX_TOTAL_MEMBERS) fail("policy.roles", "contains too many members");
        const memberPath = `${path}.members[${memberIndex}]`;
        const member = record(memberValue, memberPath);
        exactKeys(member, ["id", "address", "label"], memberPath);
        const memberId = stringValue(member.id, `${memberPath}.id`, 128, { nonempty: true });
        if (memberIds.has(memberId)) fail(`${memberPath}.id`, "must be unique within its role");
        memberIds.add(memberId);
        return {
          id: memberId,
          address: boundedDraftText(member.address, `${memberPath}.address`, 128),
          ...(member.label === undefined
            ? {}
            : { label: stringValue(member.label, `${memberPath}.label`, 256) }),
        };
      },
    );

    const permissionIds = new Set<string>();
    const permissions = arrayValue(
      role.permissions,
      `${path}.permissions`,
      MAX_TOTAL_PERMISSIONS,
    ).map((permissionValue, permissionIndex) => {
      permissionCount += 1;
      if (permissionCount > MAX_TOTAL_PERMISSIONS) {
        fail("policy.roles", "contains too many permissions");
      }
      const permissionPath = `${path}.permissions[${permissionIndex}]`;
      const permission = record(permissionValue, permissionPath);
      exactKeys(
        permission,
        [
          "id",
          "name",
          "targetAddress",
          "mode",
          "signature",
          "signatureLabel",
          "selector",
          "send",
          "delegatecall",
          "conditions",
          "rawCondition",
        ],
        permissionPath,
      );
      const permissionId = stringValue(permission.id, `${permissionPath}.id`, 128, {
        nonempty: true,
      });
      if (permissionIds.has(permissionId)) {
        fail(`${permissionPath}.id`, "must be unique within its role");
      }
      permissionIds.add(permissionId);
      if (permission.mode !== "function" && permission.mode !== "target") {
        fail(`${permissionPath}.mode`, 'must be "function" or "target"');
      }
      if (permission.selector !== undefined) {
        const selector = stringValue(permission.selector, `${permissionPath}.selector`, 10);
        if (!/^0x[0-9a-f]{8}$/i.test(selector)) {
          fail(`${permissionPath}.selector`, "must be bytes4 hex");
        }
      }

      const conditionIds = new Set<string>();
      const conditions = arrayValue(
        permission.conditions,
        `${permissionPath}.conditions`,
        MAX_TOTAL_CONDITIONS,
      ).map((conditionValue, conditionIndex) => {
        conditionCount += 1;
        if (conditionCount > MAX_TOTAL_CONDITIONS) {
          fail("policy.roles", "contains too many editable conditions");
        }
        const conditionPath = `${permissionPath}.conditions[${conditionIndex}]`;
        const condition = record(conditionValue, conditionPath);
        exactKeys(condition, ["id", "paramIndex", "operator", "value", "label"], conditionPath);
        const conditionId = stringValue(condition.id, `${conditionPath}.id`, 128, {
          nonempty: true,
        });
        if (conditionIds.has(conditionId)) {
          fail(`${conditionPath}.id`, "must be unique within its permission");
        }
        conditionIds.add(conditionId);
        if (
          typeof condition.operator !== "string" ||
          !CONDITION_OPERATORS.has(condition.operator as ConditionOperator)
        ) {
          fail(`${conditionPath}.operator`, "is not supported");
        }
        return {
          id: conditionId,
          paramIndex: integer(condition.paramIndex, `${conditionPath}.paramIndex`, 0, 1_024),
          operator: condition.operator as ConditionOperator,
          value: boundedDraftText(condition.value, `${conditionPath}.value`, 131_072),
          ...(condition.label === undefined
            ? {}
            : { label: stringValue(condition.label, `${conditionPath}.label`, 1_024) }),
        };
      });

      const rawBudget = { nodes: 0 };
      return {
        id: permissionId,
        name: boundedDraftText(permission.name, `${permissionPath}.name`, 256),
        targetAddress: boundedDraftText(
          permission.targetAddress,
          `${permissionPath}.targetAddress`,
          128,
        ),
        mode: permission.mode,
        signature: boundedDraftText(permission.signature, `${permissionPath}.signature`, 4_096),
        ...(permission.signatureLabel === undefined
          ? {}
          : {
              signatureLabel: stringValue(
                permission.signatureLabel,
                `${permissionPath}.signatureLabel`,
                4_096,
              ),
            }),
        ...(permission.selector === undefined
          ? {}
          : { selector: String(permission.selector).toLowerCase() }),
        send: booleanValue(permission.send, `${permissionPath}.send`),
        delegatecall: booleanValue(permission.delegatecall, `${permissionPath}.delegatecall`),
        conditions,
        ...(permission.rawCondition === undefined
          ? {}
          : {
              rawCondition: parseCondition(
                permission.rawCondition,
                `${permissionPath}.rawCondition`,
                0,
                rawBudget,
              ),
            }),
      };
    });

    return {
      id,
      key: boundedDraftText(role.key, `${path}.key`, 512),
      name: boundedDraftText(role.name, `${path}.name`, 256),
      description: boundedDraftText(role.description, `${path}.description`, 8_192),
      members,
      permissions,
      ...(role.annotations === undefined
        ? {}
        : {
            annotations: arrayValue(role.annotations, `${path}.annotations`, 512).map(
              (annotation, index) =>
                parseAnnotation(annotation, `${path}.annotations[${index}]`),
            ),
          }),
      ...(role.residualTargets === undefined
        ? {}
        : {
            residualTargets: arrayValue(
              role.residualTargets,
              `${path}.residualTargets`,
              2_048,
            ).map((target, index) =>
              parseResidualTarget(target, `${path}.residualTargets[${index}]`),
            ),
          }),
    } as DraftRole;
  });

  const allowanceIds = new Set<string>();
  const allowances = arrayValue(policy.allowances, "policy.allowances", MAX_ALLOWANCES).map(
    (entry, index) => {
      const path = `policy.allowances[${index}]`;
      const allowance = record(entry, path);
      exactKeys(
        allowance,
        ["id", "key", "balance", "maxRefill", "refill", "period", "timestamp", "label"],
        path,
      );
      const id = stringValue(allowance.id, `${path}.id`, 128, { nonempty: true });
      if (allowanceIds.has(id)) fail(`${path}.id`, "must be unique");
      allowanceIds.add(id);
      return {
        id,
        key: boundedDraftText(allowance.key, `${path}.key`, 512),
        balance: boundedDraftText(allowance.balance, `${path}.balance`, 128),
        maxRefill: boundedDraftText(allowance.maxRefill, `${path}.maxRefill`, 128),
        refill: boundedDraftText(allowance.refill, `${path}.refill`, 128),
        period: boundedDraftText(allowance.period, `${path}.period`, 128),
        timestamp: boundedDraftText(allowance.timestamp, `${path}.timestamp`, 128),
        ...(allowance.label === undefined
          ? {}
          : { label: stringValue(allowance.label, `${path}.label`, 256) }),
      };
    },
  );

  return { chainId, rolesMod, roles, allowances };
}

export type DraftCreatePayload = {
  name: string;
  chainId: number;
  rolesMod: string;
  safeAddress: string;
  policy: DraftPolicy;
  baseStateHash: string | null;
};

export function parseDraftCreatePayload(value: unknown): DraftCreatePayload {
  const body = record(value, "body");
  exactKeys(body, ["name", "chainId", "rolesMod", "safeAddress", "policy", "baseStateHash"], "body");
  const chainId = parseChainId(body.chainId);
  const rolesMod = address(body.rolesMod, "rolesMod");
  return {
    name: body.name === undefined ? "" : stringValue(body.name, "name", 256),
    chainId,
    rolesMod,
    safeAddress: address(body.safeAddress, "safeAddress"),
    policy: parseDraftPolicy(body.policy, { chainId, rolesMod }),
    baseStateHash: baseStateHash(body.baseStateHash, "baseStateHash") ?? null,
  };
}

export type DraftUpdatePayload = {
  chainId: number;
  rolesMod: string;
  version: number;
  policy: DraftPolicy;
  name?: string;
  note?: string | null;
  baseStateHash?: string | null;
};

export function parseDraftUpdatePayload(value: unknown): DraftUpdatePayload {
  const body = record(value, "body");
  exactKeys(
    body,
    ["chainId", "rolesMod", "version", "policy", "name", "note", "baseStateHash"],
    "body",
  );
  const chainId = parseChainId(body.chainId);
  const rolesMod = address(body.rolesMod, "rolesMod");
  return {
    chainId,
    rolesMod,
    version: integer(body.version, "version", 1, Number.MAX_SAFE_INTEGER - 1),
    policy: parseDraftPolicy(body.policy, { chainId, rolesMod }),
    ...(body.name === undefined ? {} : { name: stringValue(body.name, "name", 256) }),
    ...(body.note === undefined
      ? {}
      : { note: nullableString(body.note, "note", 4_096) ?? null }),
    ...(body.baseStateHash === undefined
      ? {}
      : { baseStateHash: baseStateHash(body.baseStateHash, "baseStateHash") ?? null }),
  };
}

export type ManualAbiPayload = {
  chainId: number;
  address: string;
  abi: string;
  name?: string;
};

export function parseManualAbiPayload(value: unknown): ManualAbiPayload {
  const body = record(value, "body");
  exactKeys(body, ["chainId", "address", "abi", "name"], "body");
  return {
    chainId: parseChainId(body.chainId),
    address: address(body.address, "address"),
    abi: stringValue(body.abi, "abi", MAX_ABI_BODY_BYTES, { nonempty: true }),
    ...(body.name === undefined
      ? {}
      : { name: stringValue(body.name, "name", 256) }),
  };
}

export type AbiBatchPayload = {
  chainId: number;
  addresses: string[];
};

export function parseAbiBatchPayload(value: unknown): AbiBatchPayload {
  const body = record(value, "body");
  exactKeys(body, ["chainId", "addresses"], "body");
  return {
    chainId: parseChainId(body.chainId),
    addresses: arrayValue(body.addresses, "addresses", 240).map((entry, index) =>
      address(entry, `addresses[${index}]`),
    ),
  };
}

function exactHex(value: unknown, path: string, bytes: number): `0x${string}` {
  const candidate = stringValue(value, path, 2 + bytes * 2);
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`, "i").test(candidate)) {
    fail(path, `must be ${bytes}-byte hex`);
  }
  return candidate.toLowerCase() as `0x${string}`;
}

function isTagged(value: unknown): value is Tagged {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    TAG in value &&
    typeof value[TAG] === "string"
  );
}

function canonicalBigInt(value: string, path: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value) || value.length > MAX_BIGINT_DIGITS) {
    fail(path, "must be a canonical non-negative integer");
  }
  const parsed = BigInt(value);
  if (parsed > (1n << 256n) - 1n) fail(path, "exceeds uint256");
  return parsed;
}

function bigintWire(value: unknown, path: string, bits: 64 | 128): bigint {
  const parsed =
    typeof value === "bigint"
      ? value
      : isTagged(value)
        ? canonicalBigInt(value[TAG], path)
        : fail(path, `must use the { "${TAG}": "…" } integer encoding`);
  if (parsed < 0n || parsed > (1n << BigInt(bits)) - 1n) {
    fail(path, `must fit uint${bits}`);
  }
  return parsed;
}

function executionOptions(value: unknown, path: string): number {
  return integer(value, path, 0, 3);
}

function parseCall(value: unknown, path: string): Call {
  const item = record(value, path);
  const kind = stringValue(item.call, `${path}.call`, 32, { nonempty: true });
  switch (kind) {
    case "allowTarget":
      exactKeys(item, ["call", "roleKey", "targetAddress", "executionOptions"], path);
      return {
        call: kind,
        roleKey: exactHex(item.roleKey, `${path}.roleKey`, 32),
        targetAddress: address(item.targetAddress, `${path}.targetAddress`) as `0x${string}`,
        executionOptions: executionOptions(item.executionOptions, `${path}.executionOptions`),
      } as Call;
    case "scopeTarget":
    case "revokeTarget":
      exactKeys(item, ["call", "roleKey", "targetAddress"], path);
      return {
        call: kind,
        roleKey: exactHex(item.roleKey, `${path}.roleKey`, 32),
        targetAddress: address(item.targetAddress, `${path}.targetAddress`) as `0x${string}`,
      } as Call;
    case "allowFunction":
      exactKeys(
        item,
        ["call", "roleKey", "targetAddress", "selector", "executionOptions"],
        path,
      );
      return {
        call: kind,
        roleKey: exactHex(item.roleKey, `${path}.roleKey`, 32),
        targetAddress: address(item.targetAddress, `${path}.targetAddress`) as `0x${string}`,
        selector: exactHex(item.selector, `${path}.selector`, 4),
        executionOptions: executionOptions(item.executionOptions, `${path}.executionOptions`),
      } as Call;
    case "scopeFunction":
      exactKeys(
        item,
        ["call", "roleKey", "targetAddress", "selector", "condition", "executionOptions"],
        path,
      );
      return {
        call: kind,
        roleKey: exactHex(item.roleKey, `${path}.roleKey`, 32),
        targetAddress: address(item.targetAddress, `${path}.targetAddress`) as `0x${string}`,
        selector: exactHex(item.selector, `${path}.selector`, 4),
        condition: parseCondition(item.condition, `${path}.condition`, 0, { nodes: 0 }),
        executionOptions: executionOptions(item.executionOptions, `${path}.executionOptions`),
      } as Call;
    case "revokeFunction":
      exactKeys(item, ["call", "roleKey", "targetAddress", "selector"], path);
      return {
        call: kind,
        roleKey: exactHex(item.roleKey, `${path}.roleKey`, 32),
        targetAddress: address(item.targetAddress, `${path}.targetAddress`) as `0x${string}`,
        selector: exactHex(item.selector, `${path}.selector`, 4),
      } as Call;
    case "assignRoles":
      exactKeys(item, ["call", "roleKey", "member", "join"], path);
      return {
        call: kind,
        roleKey: exactHex(item.roleKey, `${path}.roleKey`, 32),
        member: address(item.member, `${path}.member`) as `0x${string}`,
        join: booleanValue(item.join, `${path}.join`),
      } as Call;
    case "setAllowance":
      exactKeys(
        item,
        ["call", "key", "balance", "maxRefill", "refill", "period", "timestamp"],
        path,
      );
      return {
        call: kind,
        key: exactHex(item.key, `${path}.key`, 32),
        balance: bigintWire(item.balance, `${path}.balance`, 128),
        maxRefill: bigintWire(item.maxRefill, `${path}.maxRefill`, 128),
        refill: bigintWire(item.refill, `${path}.refill`, 128),
        period: bigintWire(item.period, `${path}.period`, 64),
        timestamp: bigintWire(item.timestamp, `${path}.timestamp`, 64),
      } as Call;
    case "postAnnotations": {
      exactKeys(item, ["call", "roleKey", "body"], path);
      const bodyPath = `${path}.body`;
      const body = record(item.body, bodyPath);
      exactKeys(body, ["addAnnotations", "removeAnnotations"], bodyPath);
      const addAnnotations =
        body.addAnnotations === undefined
          ? undefined
          : arrayValue(body.addAnnotations, `${bodyPath}.addAnnotations`, 512).map(
              (annotationValue, index) => {
                const annotationPath = `${bodyPath}.addAnnotations[${index}]`;
                const annotation = record(annotationValue, annotationPath);
                exactKeys(annotation, ["uris", "schema"], annotationPath);
                return {
                  uris: arrayValue(annotation.uris, `${annotationPath}.uris`, 512).map(
                    (uri, uriIndex) =>
                      stringValue(uri, `${annotationPath}.uris[${uriIndex}]`, 4_096, {
                        nonempty: true,
                      }),
                  ),
                  schema: stringValue(annotation.schema, `${annotationPath}.schema`, 16_384),
                };
              },
            );
      const removeAnnotations =
        body.removeAnnotations === undefined
          ? undefined
          : arrayValue(body.removeAnnotations, `${bodyPath}.removeAnnotations`, 512).map(
              (uri, index) =>
                stringValue(uri, `${bodyPath}.removeAnnotations[${index}]`, 4_096, {
                  nonempty: true,
                }),
            );
      return {
        call: kind,
        roleKey: exactHex(item.roleKey, `${path}.roleKey`, 32),
        body: {
          ...(addAnnotations === undefined ? {} : { addAnnotations }),
          ...(removeAnnotations === undefined ? {} : { removeAnnotations }),
        },
      } as Call;
    }
    default:
      fail(`${path}.call`, "is not a supported Roles call");
  }
}

export function parseCalls(value: unknown, path = "calls"): Call[] {
  return arrayValue(value, path, MAX_CALLS).map((call, index) =>
    parseCall(call, `${path}[${index}]`),
  );
}

export type ProposalSubmission =
  | { kind: "safeTxHash"; safeTxHash: string }
  | { kind: "bundleId"; bundleId: string }
  | { kind: "txHashes"; txHashes: string[] };

export function parseProposalSubmission(
  value: unknown,
  path = "submission",
): ProposalSubmission {
  const submission = record(value, path);
  const kind = stringValue(submission.kind, `${path}.kind`, 16, { nonempty: true });
  if (kind === "safeTxHash") {
    exactKeys(submission, ["kind", "safeTxHash"], path);
    return { kind, safeTxHash: exactHex(submission.safeTxHash, `${path}.safeTxHash`, 32) };
  }
  if (kind === "bundleId") {
    exactKeys(submission, ["kind", "bundleId"], path);
    const bundleId = stringValue(submission.bundleId, `${path}.bundleId`, 512, {
      nonempty: true,
    });
    if (/[\u0000-\u001f\u007f]/.test(bundleId)) {
      fail(`${path}.bundleId`, "must not contain control characters");
    }
    return { kind, bundleId };
  }
  if (kind === "txHashes") {
    exactKeys(submission, ["kind", "txHashes"], path);
    const txHashes = arrayValue(submission.txHashes, `${path}.txHashes`, MAX_CALLS).map(
      (hash, index) => exactHex(hash, `${path}.txHashes[${index}]`, 32),
    );
    if (txHashes.length === 0) fail(`${path}.txHashes`, "must not be empty");
    if (new Set(txHashes).size !== txHashes.length) {
      fail(`${path}.txHashes`, "must not contain duplicate hashes");
    }
    return { kind, txHashes };
  }
  fail(`${path}.kind`, "is not supported");
}

export type ProposalPayload = {
  draftId: string | null;
  chainId: number;
  rolesMod: string;
  safeAddress: string;
  submission: ProposalSubmission;
  risk: "Low" | "Medium" | "High" | "Critical";
  calls: Call[];
};

export function parseProposalPayload(value: unknown): ProposalPayload {
  const body = record(value, "body");
  exactKeys(
    body,
    ["draftId", "chainId", "rolesMod", "safeAddress", "submission", "risk", "calls"],
    "body",
  );
  const risk = body.risk === undefined ? "Low" : stringValue(body.risk, "risk", 8);
  if (risk !== "Low" && risk !== "Medium" && risk !== "High" && risk !== "Critical") {
    fail("risk", "must be Low, Medium, High or Critical");
  }
  const calls = parseCalls(body.calls);
  if (calls.length === 0) fail("calls", "must not be empty");
  const submission = parseProposalSubmission(body.submission);
  if (
    submission.kind === "txHashes" &&
    submission.txHashes.length > calls.length
  ) {
    fail("submission.txHashes", "cannot outnumber the recorded calls");
  }
  return {
    draftId: optionalId(body.draftId, "draftId", "draft"),
    chainId: parseChainId(body.chainId),
    rolesMod: address(body.rolesMod, "rolesMod"),
    safeAddress: address(body.safeAddress, "safeAddress"),
    submission,
    risk,
    calls,
  };
}

export type DraftScopeInput = {
  chainId: number;
  rolesMod: string;
  version?: number;
};

export function parseDraftScope(
  url: URL,
  options: { requireVersion?: boolean } = {},
): DraftScopeInput {
  const chainRaw = url.searchParams.get("chainId");
  const rolesModRaw = url.searchParams.get("rolesMod");
  if (chainRaw === null || rolesModRaw === null) {
    throw new InputError("Provide chainId and rolesMod.");
  }
  const chainId = Number(chainRaw);
  const result: DraftScopeInput = {
    chainId: parseChainId(chainId),
    rolesMod: address(rolesModRaw, "rolesMod"),
  };
  if (options.requireVersion) {
    const versionRaw = url.searchParams.get("version");
    if (versionRaw === null) throw new InputError("Provide the draft version.");
    result.version = integer(Number(versionRaw), "version", 1, Number.MAX_SAFE_INTEGER - 1);
  }
  return result;
}

export function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry) =>
    typeof entry === "bigint" ? { [TAG]: entry.toString() } : entry,
  );
}

function reviveEntry(entry: unknown): unknown {
  if (!isTagged(entry)) return entry;
  return canonicalBigInt(entry[TAG], TAG);
}

export function parse<T>(text: string): T {
  return JSON.parse(text, (_key, entry) => reviveEntry(entry)) as T;
}

/** Revives tagged values in an already-parsed structure. */
export function revive<T>(value: unknown, depth = 0): T {
  if (depth > MAX_REVIVE_DEPTH) throw new InputError("JSON value is nested too deeply.");
  if (Array.isArray(value)) {
    return value.map((entry) => revive(entry, depth + 1)) as T;
  }
  if (isTagged(value)) return reviveEntry(value) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, revive(entry, depth + 1)]),
    ) as T;
  }
  return value as T;
}

export function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(stringify(value), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...init?.headers,
    },
  });
}
