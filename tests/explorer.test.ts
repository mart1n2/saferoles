import test from "node:test";
import assert from "node:assert/strict";
import { addressExplorerUrl } from "../app/lib/explorer";

const usdt = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

test("builds an https explorer address link for supported chains", () => {
  assert.equal(addressExplorerUrl(1, usdt), `https://etherscan.io/address/${usdt}`);
  assert.match(addressExplorerUrl(8453, usdt) ?? "", /^https:\/\/.+\/address\/0xdAC1/);
});

test("refuses unknown chains and anything that is not an address", () => {
  assert.equal(addressExplorerUrl(999999, usdt), null);
  assert.equal(addressExplorerUrl(1, "0x1234"), null);
  assert.equal(addressExplorerUrl(1, "javascript:alert(1)"), null);
  assert.equal(addressExplorerUrl(1, ""), null);
});

import { summaryParts, type PlannedChange } from "../app/lib/policy-plan";

const change = (call: Record<string, unknown>): PlannedChange =>
  ({ id: "c", call, action: "Grant", scope: "bot", summary: "plain", detail: "", risk: "Low" }) as unknown as PlannedChange;

test("review summaries use function and contract names when known", () => {
  const names = (address: string, selector: string) =>
    address === usdt && selector === "0xa9059cbb" ? "transfer(address _to, uint256 _value)" : null;
  assert.deepEqual(
    summaryParts(change({ call: "scopeFunction", targetAddress: usdt, selector: "0xa9059cbb" }), names),
    ["Allow transfer on ", { contract: usdt }, " under conditions"],
  );
  assert.deepEqual(
    summaryParts(change({ call: "revokeFunction", targetAddress: usdt, selector: "0x095ea7b3" }), names),
    ["Revoke 0x095ea7b3 on ", { contract: usdt }],
  );
  assert.deepEqual(summaryParts(change({ call: "scopeTarget", targetAddress: usdt }), names), ["Restrict ", { contract: usdt }, " to named functions"]);
  assert.deepEqual(summaryParts(change({ call: "assignRoles", member: usdt }), names), ["plain"]);
});

import { conditionAddresses } from "../app/components/permission-conditions";
import { Operator, ParameterType } from "zodiac-roles-sdk";
import type { DraftPermission } from "../app/lib/policy";

const base: DraftPermission = {
  id: "p", name: "", targetAddress: usdt, mode: "function", signature: "", selector: "0xa9059cbb",
  send: false, delegatecall: false, conditions: [],
  rawCondition: {
    paramType: ParameterType.Calldata, operator: Operator.Matches,
    children: [
      { paramType: ParameterType.Static, operator: Operator.EqualTo, compValue: "0x0000000000000000000000005112734d7c7fed6dce995cc25a769ee5d608497f", children: [] },
      { paramType: ParameterType.Static, operator: Operator.LessThan, compValue: "0x000000000000000000000000000000000000000000000000000000003b9aca00", children: [] },
    ],
  },
};

test("pinned address parameters are listed by name, from a raw or decoded condition", () => {
  const expected = [{ name: "_to", address: "0x5112734d7C7fed6dCe995Cc25A769ee5D608497F" }];
  assert.deepEqual(conditionAddresses(base, "transfer(address _to, uint256 _value)"), expected);
  const decoded: DraftPermission = { ...base, rawCondition: undefined, signature: "transfer(address,uint256)", conditions: [{ id: "c", paramIndex: 0, operator: "eq", value: "0x5112734d7c7fed6dce995cc25a769ee5d608497f" }] };
  assert.deepEqual(conditionAddresses(decoded, "transfer(address _to, uint256 _value)"), expected);
});

test("a number that only looks like a padded address is never listed", () => {
  const asUint: DraftPermission = { ...base, rawCondition: { ...base.rawCondition!, children: [{ paramType: ParameterType.Static, operator: Operator.EqualTo, compValue: "0x0000000000000000000000005112734d7c7fed6dce995cc25a769ee5d608497f", children: [] }] } };
  assert.deepEqual(conditionAddresses(asUint, "foo(uint256 amount)"), [], "uint256 parameter");
  assert.deepEqual(conditionAddresses(base, ""), [], "no trusted signature");
  assert.deepEqual(conditionAddresses(base, "approve(address,uint256)"), [], "signature for a different selector");
});

test("links follow the chain and never fall back to a default chain", () => {
  assert.equal(addressExplorerUrl(null, usdt), null);
  assert.equal(addressExplorerUrl(10, usdt), `https://optimistic.etherscan.io/address/${usdt}`);
  assert.equal(addressExplorerUrl(8453, usdt), `https://basescan.org/address/${usdt}`);
  assert.equal(addressExplorerUrl(42161, usdt), `https://arbiscan.io/address/${usdt}`);
});
