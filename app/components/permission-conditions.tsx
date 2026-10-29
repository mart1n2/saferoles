import { AbiCoder, getAddress, isAddress } from "ethers";
import { Operator, ParameterType, type Condition } from "zodiac-roles-sdk";
import { parseSignature } from "../lib/abi";
import { conditionOperatorLabels, type DraftPermission } from "../lib/policy";
import { conditionParameterName, conditionSummaryDetails, tokenAmountIndex, type ConditionSummaryLine } from "../lib/condition-summary";
import { useTokenMetadata } from "../lib/use-token-metadata";
import { AddressLabel } from "./address-link";

export function PermissionConditions({ permission, signature, chainId }: { permission: DraftPermission; signature: string; chainId: number }) {
  // Directory guesses and signatures for a different selector cannot name parameters.
  let trustedSignature: string | undefined;
  try {
    const parsed = parseSignature(signature);
    if (!permission.selector || parsed.selector.toLowerCase() === permission.selector.toLowerCase()) trustedSignature = signature;
  } catch { /* Fall back to positional labels. */ }
  const amountIndex = tokenAmountIndex(trustedSignature);
  const amountCondition = amountIndex === null ? undefined : permission.rawCondition?.operator === Operator.Matches ? permission.rawCondition.children?.[amountIndex] : undefined;
  const needsTokenAmount = amountIndex !== null && (
    Boolean(amountCondition && [Operator.EqualTo, Operator.GreaterThan, Operator.LessThan].includes(amountCondition.operator)) ||
    permission.conditions.some((entry) => entry.paramIndex === amountIndex && ["eq", "gt", "gte", "lt", "lte"].includes(entry.operator))
  );
  const address = permission.targetAddress.trim().toLowerCase();
  const { data: token } = useTokenMetadata(chainId, address, needsTokenAmount);
  const context = { signature: trustedSignature, token };
  let lines: ConditionSummaryLine[];
  if (permission.rawCondition) lines = conditionSummaryDetails(permission.rawCondition, context);
  else lines = permission.conditions.filter((entry) => entry.operator !== "pass").map((entry) => {
    const name = conditionParameterName(trustedSignature, entry.paramIndex);
    const symbols = { eq: "=", gt: ">", gte: "≥", lt: "<", lte: "≤" };
    if (entry.operator in symbols) {
      try {
        const params = parseSignature(trustedSignature ?? "").params;
        const children: Condition[] = Array.from({ length: entry.paramIndex + 1 }, () => ({ paramType: ParameterType.Static, operator: Operator.Pass }));
        children[entry.paramIndex] = { paramType: ParameterType.Static, operator: Operator.EqualTo, compValue: AbiCoder.defaultAbiCoder().encode([params[entry.paramIndex]!.type], [entry.value]) as `0x${string}` };
        const line = conditionSummaryDetails({ paramType: ParameterType.Calldata, operator: Operator.Matches, children }, context)[0]!;
        const symbol = symbols[entry.operator as keyof typeof symbols];
        return { ...line, text: line.text.replace(" = ", ` ${symbol} `), title: line.title.replace(" = ", ` ${symbol} `).replace("the deployed condition is preserved", "draft values are unchanged"), ...(line.lead ? { lead: line.lead.replace(" = ", ` ${symbol} `) } : {}) };
      } catch { /* Incomplete edits remain visible without interpretation. */ }
    }
    const text = entry.operator === "avatar" ? `${name} = Safe` : `${name} · ${conditionOperatorLabels[entry.operator]}${entry.value ? ` ${entry.value}` : ""}`;
    return { text, title: text };
  });
  if (!lines.length) return <span className={`condition-chip ${permission.rawCondition ? "locked" : "neutral"}`}>{permission.rawCondition ? "Deployed condition" : "Unconstrained"}</span>;
  return <>
    {lines.slice(0, 2).map((line, index) => line.address
      ? <span className={`condition-chip with-address ${permission.rawCondition ? "locked" : ""}`} key={index} title={line.title}>{line.lead} <AddressLabel chainId={chainId} address={line.address} /></span>
      : <span className={`condition-chip ${permission.rawCondition ? "locked" : ""}`} key={index} title={line.title} aria-label={line.title}>{line.text}</span>)}
    {lines.length > 2 && <span className="condition-chip neutral" title={lines.slice(2).map((line) => line.title).join("\n")}>+{lines.length - 2} more</span>}
  </>;
}

/** A signature only names parameters when it hashes to the permission's selector. */
function trustedSignatureFor(permission: DraftPermission, signature: string): string | undefined {
  try {
    const parsed = parseSignature(signature);
    if (!permission.selector || parsed.selector.toLowerCase() === permission.selector.toLowerCase()) return signature;
  } catch { /* No trusted signature. */ }
  return undefined;
}

export type ConditionAddress = { name: string; address: string };

/**
 * Addresses a permission pins an `address` parameter to, with the parameter's
 * name. Needs a trusted signature: without one a static value that merely looks
 * like a padded address could be a number.
 */
export function conditionAddresses(permission: DraftPermission, signature: string): ConditionAddress[] {
  const trusted = trustedSignatureFor(permission, signature);
  if (!trusted) return [];
  let types: string[];
  try { types = parseSignature(trusted).params.map((param) => param.type); } catch { return []; }
  const found: ConditionAddress[] = [];
  const add = (index: number, address: string) => {
    if (types[index] === "address" && isAddress(address.toLowerCase())) {
      found.push({ name: conditionParameterName(trusted, index), address: getAddress(address.toLowerCase()) });
    }
  };
  if (permission.rawCondition) {
    if (permission.rawCondition.operator === Operator.Matches) {
      permission.rawCondition.children?.forEach((child, index) => {
        if (child.operator === Operator.EqualTo && child.compValue && /^0x0{24}[0-9a-f]{40}$/i.test(child.compValue)) add(index, `0x${child.compValue.slice(26)}`);
      });
    }
  } else {
    for (const entry of permission.conditions) if (entry.operator === "eq") add(entry.paramIndex, entry.value.trim());
  }
  return found;
}

/** Pinned address parameters as inline "name = address" items, for places that have no chips, such as the review list. */
export function PinnedAddresses({ permission, signature, chainId }: { permission: DraftPermission; signature: string; chainId: number }) {
  const entries = conditionAddresses(permission, signature);
  if (!entries.length) return null;
  return <span className="pinned-addresses">{entries.map((entry, index) => (
    <span className="pinned-address" key={`${entry.name}-${index}`}>{entry.name} = <AddressLabel chainId={chainId} address={entry.address} /></span>
  ))}</span>;
}
