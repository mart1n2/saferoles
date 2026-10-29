import assert from "node:assert/strict";
import test from "node:test";
import { AbiCoder, MaxUint256 } from "ethers";
import { Operator, ParameterType, type Condition } from "zodiac-roles-sdk";
import { conditionSummaryDetails, tokenAmountIndex } from "../app/lib/condition-summary";

const coder = AbiCoder.defaultAbiCoder();
const token = { decimals: 6, symbol: "USDC" };
function condition(value: bigint, operator = Operator.LessThan): Condition {
  return { paramType: ParameterType.Calldata, operator: Operator.Matches, children: [
    { paramType: ParameterType.Static, operator: Operator.EqualTo, compValue: coder.encode(["address"], ["0x511200000000000000000000000000000000497f"]) as `0x${string}` },
    { paramType: ParameterType.Static, operator, compValue: coder.encode(["uint256"], [value]) as `0x${string}` },
  ] };
}
const signature = "transfer(address to, uint256 value)";

test("ABI parameter names and exact token decimals replace positional base-unit labels", () => {
  const input = condition(1_000_000_000n);
  const before = JSON.stringify(input);
  const lines = conditionSummaryDetails(input, { signature, token });
  assert.equal(lines[0]!.text, "to = 0x511200…00497F");
  assert.equal(lines[1]!.text, "value < 1,000 USDC");
  assert.match(lines[1]!.title, /1000000000 base units/);
  assert.equal(JSON.stringify(input), before);
  assert.equal(conditionSummaryDetails(condition(1n), { signature, token })[1]!.text, "value < 0.000001 USDC");
});

test("infinity is based on human token quantities, strictly above one billion", () => {
  const threshold = 1_000_000_000n * 10n ** 6n;
  assert.equal(conditionSummaryDetails(condition(threshold), { signature, token })[1]!.text, "value < 1,000,000,000 USDC");
  for (const value of [threshold + 1n, MaxUint256]) {
    const line = conditionSummaryDetails(condition(value, Operator.EqualTo), { signature: "approve(address spender, uint256 value)", token })[1]!;
    assert.equal(line.text, "value = ∞ USDC");
    assert.ok(line.title.includes(value.toString()));
    assert.match(line.title, /exact constraint still applies/);
  }
});

test("ordinary integers and unknown metadata are never assigned token decimals or infinity", () => {
  assert.equal(conditionSummaryDetails(condition(1000000000n), { signature })[1]!.text, "value < 1000000000");
  assert.equal(conditionSummaryDetails(condition(MaxUint256), { signature: "setLimit(address user, uint256 id)", token })[1]!.text, `id < ${MaxUint256}`);
  assert.equal(tokenAmountIndex("safeTransferFrom(address from, address to, uint256 tokenId)"), null);
  assert.equal(tokenAmountIndex("transferFrom(address from, address to, uint256 amount)"), 2);
});

test("18-decimal amounts stay exact without passing through floating point", () => {
  const value = 123456789123456789n;
  assert.equal(conditionSummaryDetails(condition(value), { signature, token: { decimals: 18, symbol: "DAI" } })[1]!.text, "value < 0.123456789123456789 DAI");
});
