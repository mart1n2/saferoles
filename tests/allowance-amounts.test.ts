import assert from "node:assert/strict";
import test from "node:test";
import { allowanceBaseUnits, withAllowanceDecimals, editAllowanceAmount, hasCustomInitialBalance, isExistingAllowance } from "../app/lib/allowance-amounts";
import { encodeKey } from "zodiac-roles-sdk";
import { toSdkState } from "../app/lib/policy-codec";
import { parseDraftPolicy } from "../app/lib/serialize";
import type { DraftAllowance, DraftPolicy } from "../app/lib/policy";

const legacy: DraftAllowance = { id: "a1", key: "usdc_daily", balance: "1000000000", maxRefill: "1000000000", refill: "1000000000", period: "86400", timestamp: "123" };
const policy = (allowance: DraftAllowance): DraftPolicy => ({ chainId: 1, rolesMod: `0x${"1".repeat(40)}`, roles: [], allowances: [allowance] });

test("token amounts convert exactly, without floating point rounding", () => {
  assert.equal(allowanceBaseUnits("1000", 6), 1000000000n);
  assert.equal(allowanceBaseUnits("0.000001", 6), 1n);
  assert.equal(allowanceBaseUnits("123456789.123456789123456789", 18), 123456789123456789123456789n);
  for (const input of ["-1", "1e6", "1,000", "0.0000001", "", "340282366920938463463374607431768211456"]) assert.throws(() => allowanceBaseUnits(input, 6));
});

test("changing display decimals and saving preserves deployed quantities and refill window", () => {
  const human = withAllowanceDecimals(legacy, 6);
  assert.equal(human.balance, "1000");
  const changed = withAllowanceDecimals(human, 18);
  const restored = parseDraftPolicy(policy(changed), policy(changed));
  const result = toSdkState(restored);
  assert.deepEqual(result.issues, []);
  assert.equal(result.state.allowances[0]!.balance, 1000000000n);
  assert.equal(result.state.allowances[0]!.timestamp, 123n);
  assert.deepEqual(toSdkState(policy(legacy)).state, result.state);
});

test("decimal inputs reach the planner in base units, invalid drafts cannot produce calls", () => {
  const input = { ...legacy, amountDecimals: 6, balance: "1000.5", maxRefill: "2000", refill: "10" };
  assert.equal(toSdkState(policy(input)).state.allowances[0]!.balance, 1000500000n);
  assert.ok(toSdkState(policy({ ...input, balance: "0.0000001" })).issues.length);
  assert.throws(() => parseDraftPolicy(policy({ ...input, amountDecimals: 37 }), policy(input)));
});

test("new budgets start at the ceiling and keep following edits after local recovery", () => {
  const fresh = { ...legacy, amountDecimals: 6, customInitialBalance: false, balance: "0", maxRefill: "0", refill: "10" };
  const edited = editAllowanceAmount(fresh, "maxRefill", "1000", 6, false);
  assert.equal(edited.balance, "1000");
  const restored = parseDraftPolicy(policy(edited), policy(edited)).allowances[0]!;
  const updated = editAllowanceAmount(restored, "maxRefill", "2000", 6, false);
  assert.equal(updated.balance, "2000");
  assert.equal(toSdkState(policy(updated)).state.allowances[0]!.balance, 2000000000n);
});

test("editing existing ceilings never replenishes spent balances or changes the window", () => {
  const deployed = { ...withAllowanceDecimals(legacy, 6), balance: "200", customInitialBalance: false };
  const updated = editAllowanceAmount(deployed, "maxRefill", "2000", 6, true);
  assert.equal(updated.balance, "200");
  assert.equal(updated.timestamp, deployed.timestamp);
  assert.ok(isExistingAllowance(updated, [{ key: encodeKey(deployed.key) }]));
  assert.equal(isExistingAllowance({ ...updated, key: "other" }, [{ key: encodeKey(deployed.key) }]), false);
});

test("custom initial budgets and older partially funded drafts stay intact", () => {
  const older = { ...withAllowanceDecimals(legacy, 6), balance: "100" };
  assert.ok(hasCustomInitialBalance(older));
  assert.equal(editAllowanceAmount(older, "maxRefill", "2000", 6, false).balance, "100");
  const custom = { ...older, balance: "1000", customInitialBalance: true };
  const restored = parseDraftPolicy(policy(custom), policy(custom)).allowances[0]!;
  assert.ok(hasCustomInitialBalance(restored));
  assert.equal(editAllowanceAmount(restored, "maxRefill", "2000", 6, false).balance, "1000");
});
