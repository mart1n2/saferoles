import assert from "node:assert/strict";
import test from "node:test";
import { id, ParamType } from "ethers";
import { Operator, ParameterType, type Condition } from "zodiac-roles-sdk";
import { classifyMastercopy, proxyImplementation, ROLES_MASTERCOPY_AFFECTED } from "../app/lib/onchain-mods";
import type { DraftPermission, DraftPolicy } from "../app/lib/policy";
import { fromRolesMod, toSdkState } from "../app/lib/policy-codec";
import { buildPlan } from "../app/lib/policy-plan";
import { legacyEncoding, legacyFixedArrays, openMorphoCallback, plannedCallIssues, reencodePermission, standingWarnings, ZERO_ADDRESS } from "../app/lib/policy-safety";
import { APPROVED_ROLES_MASTERCOPY } from "../app/lib/setup-roles";

const rolesMod = "0x0f253F99a3AC0122cc9ef0d61e35F27d6d017269";
const member = "0x66e5C961140dbC5859A39853f2cCfA4fA4F7A07a";
const adapter = "0x4A6c312ec70E8747a587EE860a0353cd42Be0aE0";
const usdc = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const mod = {
  address: rolesMod, owner: rolesMod, avatar: rolesMod, target: rolesMod, multiSendAddresses: [], allowances: [],
  roles: [{ key: "0x626f740000000000000000000000000000000000000000000000000000000000" as const, members: [member], annotations: [], lastUpdate: 1, targets: [] }],
};
const current = { roles: mod.roles, allowances: mod.allowances } as never;
const flashLoan = "morphoFlashLoan(address,uint256,bytes)";
const flashLoanSelector = id(flashLoan).slice(0, 10);

function permission(overrides: Partial<DraftPermission>): DraftPermission {
  return { id: "p", name: "", targetAddress: adapter, mode: "function", signature: flashLoan, send: false, delegatecall: false, conditions: [], ...overrides } as DraftPermission;
}
function withPermission(added: DraftPermission): DraftPolicy {
  const draft = fromRolesMod(mod as never, 1);
  draft.roles[0]!.permissions.push(added);
  return draft;
}
function plan(draft: DraftPolicy) {
  const { state, issues } = toSdkState(draft);
  const built = buildPlan({ rolesMod, current, desired: state, issues });
  return { built, unsafe: plannedCallIssues(built.calls, draft) };
}

test("a Morpho callback action is blocked until its data is pinned to empty", () => {
  const open = plan(withPermission(permission({ id: "open", conditions: [{ id: "c", paramIndex: 0, operator: "eq", value: usdc }] })));
  assert.equal(open.unsafe.length, 1);
  assert.match(open.unsafe[0]!.message, /morphoFlashLoan .* data parameter set to equal 0x/);
  assert.equal(open.unsafe[0]!.permissionId, "open", "the issue jumps to the permission");

  const wildcard = plan(withPermission(permission({ id: "any" })));
  assert.equal(wildcard.unsafe.length, 1, "allowed without conditions is open too");

  const pinned = plan(withPermission(permission({ conditions: [{ id: "c", paramIndex: 2, operator: "eq", value: "0x" }] })));
  assert.deepEqual(pinned.unsafe, [], "the editor's own encoding of data = 0x counts as pinned");
  const scope = pinned.built.calls.find((call) => call.call === "scopeFunction") as { selector: string; condition: Condition };
  assert.equal(openMorphoCallback(scope.selector, scope.condition), null);
});

test("a permission on the zero address is blocked", () => {
  const { unsafe } = plan(withPermission(permission({ targetAddress: ZERO_ADDRESS, mode: "target", signature: "" })));
  assert.ok(unsafe.some((issue) => /zero address/.test(issue.message)));
});

test("revocations are never blocked", () => {
  const issues = plannedCallIssues([
    { call: "revokeFunction", roleKey: mod.roles[0]!.key, targetAddress: adapter, selector: flashLoanSelector },
    { call: "revokeTarget", roleKey: mod.roles[0]!.key, targetAddress: ZERO_ADDRESS },
  ], null);
  assert.deepEqual(issues, []);
});

test("permissions already on chain are reported, not blocked", () => {
  const onChain = {
    roles: [{
      ...mod.roles[0],
      targets: [
        { address: adapter, clearance: 2, executionOptions: 0, functions: [{ selector: flashLoanSelector, wildcarded: true, executionOptions: 0 }] },
        { address: ZERO_ADDRESS, clearance: 1, executionOptions: 0, functions: [] },
      ],
    }],
    allowances: [],
  };
  const warnings = standingWarnings(onChain as never);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((warning) => /morphoFlashLoan/.test(warning)));
  assert.ok(warnings.some((warning) => /zero address/.test(warning)));
});

// ------------------------------------------------------------ fixed-size arrays

const pass = (paramType: ParameterType, children?: Condition[]): Condition => ({ paramType, operator: Operator.Pass, ...(children ? { children } : {}) });
const signature = "set(uint256[2],uint256)";
const params = [ParamType.from("uint256[2]"), ParamType.from("uint256")];
const five = `0x${"0".repeat(63)}5` as const;
/** How SDKs before 4.1.5 stored `set(any, 5)`: the fixed array as a dynamic Array. */
const legacy: Condition = {
  paramType: ParameterType.Calldata,
  operator: Operator.Matches,
  children: [pass(ParameterType.Array, [pass(ParameterType.Static)]), { paramType: ParameterType.Static, operator: Operator.EqualTo, compValue: five }],
};

test("the pre-4.1.5 encoding of a fixed-size array is found, and only there", () => {
  assert.deepEqual(legacyFixedArrays(legacy, params), { found: true, fixable: true });
  const current: Condition = { ...legacy, children: [pass(ParameterType.Tuple, [pass(ParameterType.Static), pass(ParameterType.Static)]), legacy.children![1]!] };
  assert.deepEqual(legacyFixedArrays(current, params), { found: false, fixable: false }, "the 4.1.5 tuple form is fine");
  const dynamic = [ParamType.from("uint256[]"), ParamType.from("uint256")];
  assert.deepEqual(legacyFixedArrays(legacy, dynamic), { found: false, fixable: false }, "a dynamic array is an Array");
  const constrained: Condition = { ...legacy, children: [{ paramType: ParameterType.Array, operator: Operator.ArrayEvery, children: [{ paramType: ParameterType.Static, operator: Operator.EqualTo, compValue: "0x01" }] }, legacy.children![1]!] };
  assert.deepEqual(legacyFixedArrays(constrained, params), { found: true, fixable: false }, "a constraint inside the array cannot be rebuilt here");
  assert.equal(legacyFixedArrays({ paramType: ParameterType.None, operator: Operator.Or, children: [legacy, legacy] }, params).found, true, "inside an Or as well");
});

test("re-encoding rebuilds the same condition in the 4.1.5 form", () => {
  const stored = permission({ id: "set", targetAddress: usdc, signature, selector: id(signature).slice(0, 10), rawCondition: legacy });
  assert.equal(legacyEncoding(stored).fixable, true);
  const rebuilt = reencodePermission(stored)!;
  assert.equal(rebuilt.rawCondition, undefined);
  assert.deepEqual(rebuilt.conditions.map((condition) => [condition.paramIndex, condition.operator, condition.value]), [[1, "eq", "5"]]);

  const { state } = toSdkState(withPermission(rebuilt));
  const condition = state.roles[0]!.targets.find((target) => target.address.toLowerCase() === usdc.toLowerCase())!.functions[0]!.condition!;
  assert.equal(condition.children![0]!.paramType, ParameterType.Tuple, "the array is now a tuple of two elements");
  assert.equal(condition.children![0]!.children!.length, 2);
  assert.equal(condition.children![1]!.operator, Operator.EqualTo, "and the second parameter keeps its condition");
  assert.equal(condition.children![1]!.compValue, five);
  assert.deepEqual(legacyFixedArrays(condition, params), { found: false, fixable: false });
});

// ------------------------------------------------------------------ mastercopy

test("the Roles release is read from the minimal proxy's code", () => {
  const proxy = (implementation: string) => `0x363d3d373d3d3d363d73${implementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
  assert.equal(classifyMastercopy(proxyImplementation(proxy(APPROVED_ROLES_MASTERCOPY))).status, "current");
  assert.equal(classifyMastercopy(proxyImplementation(proxy(ROLES_MASTERCOPY_AFFECTED))).status, "affected");
  assert.equal(classifyMastercopy(proxyImplementation(proxy(usdc))).status, "unknown");
  assert.deepEqual(classifyMastercopy(proxyImplementation("0x6080604052")), { status: "unknown", implementation: null });
});
