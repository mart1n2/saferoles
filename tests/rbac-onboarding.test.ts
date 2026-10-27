import assert from "node:assert/strict";
import test from "node:test";
import { Interface } from "ethers";
import { encodeKey } from "zodiac-roles-sdk";
import { buildInitializationPlan } from "../app/lib/initialization";
import { toSdkState, fromRolesMod, lockDeployedRoleKeys } from "../app/lib/policy-codec";
import type { DraftRole } from "../app/lib/policy";

const safe = "0x1111111111111111111111111111111111111111";
const member = "0x2222222222222222222222222222222222222222";
const target = "0x3333333333333333333333333333333333333333";
const role: DraftRole = {
  id: "first", key: "ops", name: "Operations", description: "", members: [{ id: "m", address: member }],
  permissions: [{ id: "p", name: "Wrap", targetAddress: target, mode: "function", signature: "deposit()", send: true, delegatecall: false, conditions: [] }],
};
const abi = new Interface([
  "function enableModule(address module)",
  "function assignRoles(address module, bytes32[] roleKeys, bool[] memberOf)",
  "function allowFunction(bytes32 roleKey, address targetAddress, bytes4 selector, uint8 options)",
]);

test("initialization binds first-role calldata to the address it deploys and enables", () => {
  const plan = buildInitializationPlan({ safeAddress: safe, saltNonce: "10", chainId: 1, role });
  assert.deepEqual(plan.issues, []);
  assert.ok(plan.transactions.length > 2);
  assert.equal(abi.parseTransaction({ data: plan.transactions[1].data })!.args.module, plan.predictedAddress);
  for (const tx of plan.transactions.slice(2)) assert.equal(tx.to.toLowerCase(), plan.predictedAddress.toLowerCase());
  const calls = plan.transactions.slice(2).map(tx => abi.parseTransaction({ data: tx.data }));
  const membership = calls.find(call => call?.name === "assignRoles")!;
  assert.equal(membership.args.module.toLowerCase(), member);
  assert.equal(membership.args.roleKeys[0], encodeKey("ops"));
  assert.equal(membership.args.memberOf[0], true);
  const grant = calls.find(call => call?.name === "allowFunction")!;
  assert.equal(grant.args.selector, new Interface(["function deposit()"]).getFunction("deposit")!.selector);
  const other = buildInitializationPlan({ safeAddress: safe, saltNonce: "11", chainId: 1, role });
  assert.notEqual(other.predictedAddress, plan.predictedAddress);
  assert.ok(other.transactions.slice(2).every(tx => tx.to.toLowerCase() === other.predictedAddress.toLowerCase()));
});

test("incomplete first roles and delegatecall never produce a submittable setup batch", () => {
  for (const invalid of [
    { ...role, members: [] }, { ...role, permissions: [] },
    { ...role, members: [{ id: "m", address: "0x123" }] },
    { ...role, permissions: [{ ...role.permissions[0], delegatecall: true }] },
  ]) {
    const plan = buildInitializationPlan({ safeAddress: safe, saltNonce: "1", chainId: 1, role: invalid });
    assert.ok(plan.issues.length > 0);
    assert.equal(plan.transactions.length, 0);
  }
});

test("an imported role's key is locked while labels remain editable", () => {
  const imported = fromRolesMod({ address: target, owner: safe, avatar: safe, target: safe,
    multiSendAddresses: [], roles: [{ key: encodeKey("ops"), members: [member], targets: [], annotations: [], lastUpdate: 0 }], allowances: [],
  }, 1);
  assert.equal(imported.roles[0].deployedKey, encodeKey("ops"));
  imported.roles[0].name = "Renamed operations";
  assert.deepEqual(toSdkState(imported).issues, []);
  imported.roles[0].key = "different";
  assert.match(toSdkState(imported).issues.map(i => i.message).join(" "), /deployed role key.*locked/i);
});

test("deployed role identity survives draft persistence", async () => {
  const { parseDraftPolicy } = await import("../app/lib/serialize");
  const draft = { chainId: 1, rolesMod: target, roles: [{ ...role, deployedKey: encodeKey("ops") }], allowances: [] };
  assert.equal(parseDraftPolicy(draft, { chainId: 1, rolesMod: target }).roles[0].deployedKey, encodeKey("ops"));
  assert.throws(() => parseDraftPolicy({ ...draft, roles: [{ ...draft.roles[0], deployedKey: "ops" }] }, { chainId: 1, rolesMod: target }), /bytes32/);
});

test("execution verification rejects absent code, wrong implementation, wrong wiring and disabled modules", async () => {
  const { verifyInitialization } = await import("../app/lib/initialization");
  const { APPROVED_ROLES_MASTERCOPY } = await import("../app/lib/setup-roles");
  const expected = `0x363d3d373d3d3d363d73${APPROVED_ROLES_MASTERCOPY.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
  const view = new Interface(["function owner() view returns (address)", "function avatar() view returns (address)", "function target() view returns (address)", "function isModuleEnabled(address) view returns (bool)"]);
  const check = (code: string | null, wrongField = "", enabled = true) => verifyInitialization({
    safeAddress: safe, modifierAddress: target, getCode: async () => code,
    readContract: async (to, data) => {
      const fn = view.parseTransaction({ data })!.name;
      assert.equal(to, fn === "isModuleEnabled" ? safe : target);
      return view.encodeFunctionResult(fn, [fn === "isModuleEnabled" ? enabled : fn === wrongField ? member : safe]);
    },
  });
  await check(expected);
  for (const code of [null, "0x", "0x6080604052", expected.replace(APPROVED_ROLES_MASTERCOPY.slice(2).toLowerCase(), member.slice(2))]) {
    await assert.rejects(check(code), /not deployed yet|implementation/);
  }
  for (const field of ["owner", "avatar", "target"]) await assert.rejects(check(expected, field), /does not match/);
  await assert.rejects(check(expected, "", false), /not verified as enabled/);
  await assert.rejects(verifyInitialization({ safeAddress: safe, modifierAddress: target, getCode: async () => expected, readContract: async () => null }), /Could not read/);
});

test("older saved drafts acquire key locks from the current indexed baseline", () => {
  const policy = { chainId: 1, rolesMod: target, roles: [role], allowances: [] };
  const baseline = toSdkState(policy).state;
  const restored = lockDeployedRoleKeys(policy, baseline);
  assert.equal(restored.roles[0].deployedKey, encodeKey("ops"));
  const fresh = lockDeployedRoleKeys({ ...policy, roles: [{ ...role, key: "new_role" }] }, baseline);
  assert.equal(fresh.roles[0].deployedKey, undefined);
});
