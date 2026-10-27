import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { revive } from "../app/lib/serialize";
import { callsPlannedForApply, encodeCalls } from "../app/lib/zodiac-compat";
import type { ExecutionOptions } from "zodiac-roles-sdk";
import type { SdkState } from "../app/lib/policy-codec";

const fixture = revive<{
  modifier: `0x${string}`;
  cases: { name: string; current: SdkState; desired: SdkState; calls: ReturnType<typeof callsPlannedForApply>; transactions: ReturnType<typeof encodeCalls> }[];
}>(JSON.parse(readFileSync(new URL("./fixtures/zodiac-v3-plans.json", import.meta.url), "utf8")));

for (const entry of fixture.cases) {
  test(`local v4 planner preserves v3 calls and calldata: ${entry.name}`, () => {
    const calls = callsPlannedForApply(entry.current, entry.desired);
    assert.deepEqual(calls, entry.calls);
    assert.deepEqual(encodeCalls(calls, fixture.modifier), entry.transactions);
  });
}

test("replacing delegatecall with send removes the old authority instead of planning nothing", async () => {
  const { Interface } = await import("ethers");
  const { Clearance, ExecutionOptions, encodeKey, rolesAbi } = await import("zodiac-roles-sdk");
  const abi = new Interface(rolesAbi);
  for (const clearance of [Clearance.Target, Clearance.Function]) {
    const role = (options: ExecutionOptions): SdkState => ({ roles: [{
      key: encodeKey("ops"), members: [], annotations: [], lastUpdate: 0,
      targets: [{ address: fixture.modifier, clearance, executionOptions: options,
        functions: clearance === Clearance.Function ? [{selector: "0xa9059cbb", wildcarded: true, executionOptions: options}] : [] }],
    }], allowances: [] });
    for (const [before, after] of [[ExecutionOptions.DelegateCall, ExecutionOptions.Send], [ExecutionOptions.Send, ExecutionOptions.DelegateCall]]) {
      const calls = callsPlannedForApply(role(before), role(after));
      assert.equal(calls.length, 1);
      const tx = encodeCalls(calls, fixture.modifier)[0];
      const decoded = abi.parseTransaction({data:tx.data})!;
      assert.equal(Number(decoded.args[decoded.args.length - 1]), after);
    }
  }
});
