import { Operator, type Condition } from "zodiac-roles-sdk";
import { parseSignature, shortHex } from "./abi";
import { AbiCoder, formatUnits, type ParamType } from "ethers";

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
export function summarizeCondition(condition: Condition | undefined, context: ConditionSummaryContext = {}): string[] {
  return conditionSummaryDetails(condition, context).map((line) => line.text);
}

export type ConditionSummaryContext = { signature?: string; token?: { decimals: number; symbol: string } | null };
export type ConditionSummaryLine = { text: string; title: string };

/** Only standard ERC-20 amount positions; an arbitrary uint may be an id or timestamp. */
export function tokenAmountIndex(signature: string | undefined): number | null {
  if (!signature) return null;
  try {
    const canonical = parseSignature(signature).canonical;
    if (canonical === "approve(address,uint256)" || canonical === "transfer(address,uint256)") return 1;
    if (canonical === "transferFrom(address,address,uint256)") return 2;
    return null;
  } catch { return null; }
}

export function conditionParameterName(signature: string | undefined, index: number): string {
  try { return parseSignature(signature ?? "").params[index]?.name || `arg ${index}`; }
  catch { return `arg ${index}`; }
}

function groupedAmount(value: string): string {
  const [whole, fraction] = value.split(".");
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction && !/^0+$/.test(fraction) ? `${grouped}.${fraction}` : grouped;
}

/** Names and amounts are presentation only: exact operators and words remain intact. */
export function conditionSummaryDetails(condition: Condition | undefined, context: ConditionSummaryContext = {}): ConditionSummaryLine[] {
  if (!condition) return [];
  let params: readonly ParamType[] = [];
  try { params = parseSignature(context.signature ?? "").params; } catch { /* Unknown ABI: retain positional labels and base units. */ }
  const amountIndex = tokenAmountIndex(context.signature);
  const args = condition.operator === Operator.Matches ? condition.children ?? [] : [condition];
  return args.flatMap((child, index) => {
    if (child.operator === Operator.Pass) return [];
    const label = params[index]?.name || `arg ${index}`;
    const verb = names[child.operator] ?? `operator ${child.operator}`;
    const comparable = [Operator.EqualTo, Operator.GreaterThan, Operator.LessThan, Operator.SignedIntGreaterThan, Operator.SignedIntLessThan].includes(child.operator);
    if (!comparable || !child.compValue) return [{ text: `${label} ${verb}`, title: `Exact deployed condition: ${JSON.stringify(child)}` }];
    let shown = shortWord(child.compValue);
    let exact: string = child.compValue;
    const param = params[index];
    try {
      if (param && (param.type === "address" || param.type === "bool" || /^(u?int)\d+$/.test(param.type))) {
        const decoded = AbiCoder.defaultAbiCoder().decode([param.type], child.compValue)[0];
        exact = String(decoded);
        shown = param.type === "address" ? shortHex(exact) : exact;
        if (index === amountIndex && context.token && typeof decoded === "bigint" && decoded >= 0n && Number.isInteger(context.token.decimals) && context.token.decimals >= 0 && context.token.decimals <= 36) {
          const token = context.token;
          const quantity = groupedAmount(formatUnits(decoded, token.decimals));
          const abbreviated = decoded > 1_000_000_000n * (10n ** BigInt(token.decimals));
          shown = `${abbreviated ? "∞" : quantity} ${token.symbol}`;
          exact = `${quantity} ${token.symbol} (${decoded} base units; ${token.decimals} decimals)${abbreviated ? ". ∞ abbreviates amounts above 1 billion tokens; this exact constraint still applies" : ""}`;
        }
      }
    } catch { /* Malformed or unsupported values stay raw. */ }
    return [{ text: `${label} ${verb} ${shown}`, title: `${label} ${verb} ${exact}. Display only; the deployed condition is preserved.` }];
  });
}
