import test from "node:test";
import assert from "node:assert/strict";
import { Operator, ParameterType, type Condition } from "zodiac-roles-sdk";
import { adoptSignature } from "../app/lib/policy-codec";
import { conditionShape, draftPermissionRisk, rateGrant, riskReason } from "../app/lib/policy-plan";
import type { DraftPermission } from "../app/lib/policy";

const spender = "0x00000000000000000000000087870bca3f3fd6335c3f4ce8392d69350b4fa4e2" as const;
const eqSpender: Condition = {
  paramType: ParameterType.Calldata,
  operator: Operator.Matches,
  children: [{ paramType: ParameterType.Static, operator: Operator.EqualTo, compValue: spender, children: [] }],
};

const imported = (over: Partial<DraftPermission> = {}): DraftPermission => ({
  id: "p", name: "", targetAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", mode: "function",
  signature: "", selector: "0x095ea7b3", send: false, delegatecall: false, conditions: [], rawCondition: eqSpender, ...over,
});

test("opening an imported permission does not change its rating", () => {
  const before = imported();
  const after = adoptSignature(before, "approve(address,uint256)").permission;
  assert.equal(after.rawCondition, undefined, "adoption decodes the raw tree");
  assert.equal(draftPermissionRisk(before), draftPermissionRisk(after));
  assert.equal(draftPermissionRisk(after), "Low");
  assert.equal(riskReason(before), riskReason(after));
});

test("rating rule: nothing constrained is High, value is Medium, delegatecall is Critical", () => {
  assert.equal(rateGrant("open", { delegatecall: false, send: false }).risk, "High");
  assert.equal(rateGrant("simple", { delegatecall: false, send: false }).risk, "Low");
  assert.equal(rateGrant("simple", { delegatecall: false, send: true }).risk, "Medium");
  assert.equal(rateGrant("complex", { delegatecall: false, send: false }).risk, "Medium");
  assert.equal(rateGrant("open", { delegatecall: true, send: false }).risk, "Critical");
  assert.equal(rateGrant("simple", { delegatecall: true, send: true }).risk, "Critical");
});

test("condition shape reads flat, open and nested trees", () => {
  assert.equal(conditionShape(undefined), "open");
  assert.equal(conditionShape(eqSpender), "simple");
  assert.equal(
    conditionShape({ ...eqSpender, children: [{ paramType: ParameterType.Static, operator: Operator.Pass, children: [] }] }),
    "open",
  );
  assert.equal(
    conditionShape({
      paramType: ParameterType.Calldata,
      operator: Operator.Matches,
      children: [{ paramType: ParameterType.Tuple, operator: Operator.Matches, children: [{ paramType: ParameterType.Static, operator: Operator.EqualTo, children: [] }] }],
    }),
    "complex",
  );
});

test("a decoded permission with no active condition is High", () => {
  const open = imported({ signature: "approve(address,uint256)", selector: undefined, rawCondition: undefined, conditions: [{ id: "c", paramIndex: 0, operator: "pass", value: "" }] });
  assert.equal(draftPermissionRisk(open), "High");
});

test("a condition still waiting for its value does not make a permission Low", () => {
  const base = imported({ signature: "transfer(address,uint256)", selector: undefined, rawCondition: undefined });
  const empty = { ...base, conditions: [{ id: "c", paramIndex: 0, operator: "eq" as const, value: "  " }] };
  assert.equal(draftPermissionRisk(empty), "High");
  const filled = { ...base, conditions: [{ id: "c", paramIndex: 0, operator: "eq" as const, value: "0x5112734d7c7fed6dce995cc25a769ee5d608497f" }] };
  assert.equal(draftPermissionRisk(filled), "Low");
  const avatar = { ...base, conditions: [{ id: "c", paramIndex: 0, operator: "avatar" as const, value: "" }] };
  assert.equal(draftPermissionRisk(avatar), "Low");
});
