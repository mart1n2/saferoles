import { Operator, type Condition } from "zodiac-roles-sdk";
import { shortHex } from "./abi";

const names: Record<number, string> = {
  [Operator.And]: "all of",
  [Operator.Or]: "any of",
  [Operator.Matches]: "matches",
  [Operator.ArrayEvery]: "every item",
  [Operator.EqualToAvatar]: "= Safe",
  [Operator.EqualTo]: "=",
  [Operator.GreaterThan]: ">",
  [Operator.LessThan]: "<",
  [Operator.SignedIntGreaterThan]: ">",
  [Operator.SignedIntLessThan]: "<",
  [Operator.Bitmask]: "bitmask",
  [Operator.Custom]: "custom check",
  [Operator.WithinAllowance]: "within allowance",
  [Operator.EtherWithinAllowance]: "ETH within allowance",
  [Operator.CallWithinAllowance]: "call limit",
};

/** A 32-byte word read as an address, a small integer or a short hex string. */
export function shortWord(value: string | undefined): string {
  if (!value || !/^0x[0-9a-fA-F]*$/.test(value)) return "…";
  if (value.length <= 66) {
    const number = BigInt(value === "0x" ? "0x0" : value);
    // Small words are amounts; larger ones padded to 32 bytes are addresses.
    if (number < 1n << 64n) return number.toString();
    if (value.length === 66 && /^0x0{24}/.test(value)) return shortHex(`0x${value.slice(26)}`);
    if (number < 10n ** 30n) return number.toString();
  }
  return shortHex(value);
}

/**
 * Plain-language constraints of a deployed condition, one per argument, so a
 * permission can be reviewed from the list without opening it.
 */
export function summarizeCondition(condition: Condition | undefined): string[] {
  if (!condition) return [];
  const args = condition.operator === Operator.Matches ? condition.children ?? [] : [condition];
  const lines: string[] = [];
  args.forEach((child, index) => {
    if (child.operator === Operator.Pass) return;
    const label = `arg ${index}`;
    const verb = names[child.operator] ?? `operator ${child.operator}`;
    if (child.operator === Operator.EqualTo) lines.push(`${label} = ${shortWord(child.compValue)}`);
    else if (child.operator === Operator.GreaterThan || child.operator === Operator.LessThan || child.operator === Operator.SignedIntGreaterThan || child.operator === Operator.SignedIntLessThan) lines.push(`${label} ${verb} ${shortWord(child.compValue)}`);
    else lines.push(`${label} ${verb}`);
  });
  return lines;
}
