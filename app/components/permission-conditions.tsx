import { AbiCoder } from "ethers";
import { Operator, ParameterType, type Condition } from "zodiac-roles-sdk";
import { parseSignature } from "../lib/abi";
import { conditionOperatorLabels, type DraftPermission } from "../lib/policy";
import { conditionParameterName, conditionSummaryDetails, tokenAmountIndex, type ConditionSummaryLine } from "../lib/condition-summary";
import { useTokenMetadata } from "../lib/use-token-metadata";

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
        return { text: line.text.replace(" = ", ` ${symbol} `), title: line.title.replace(" = ", ` ${symbol} `).replace("the deployed condition is preserved", "draft values are unchanged") };
      } catch { /* Incomplete edits remain visible without interpretation. */ }
    }
    const text = entry.operator === "avatar" ? `${name} = Safe` : `${name} · ${conditionOperatorLabels[entry.operator]}${entry.value ? ` ${entry.value}` : ""}`;
    return { text, title: text };
  });
  if (!lines.length) return <span className={`condition-chip ${permission.rawCondition ? "locked" : "neutral"}`}>{permission.rawCondition ? "Deployed condition" : "Unconstrained"}</span>;
  return <>
    {lines.slice(0, 2).map((line, index) => <span className={`condition-chip ${permission.rawCondition ? "locked" : ""}`} key={index} title={line.title} aria-label={line.title}>{line.text}</span>)}
    {lines.length > 2 && <span className="condition-chip neutral" title={lines.slice(2).map((line) => line.title).join("\n")}>+{lines.length - 2} more</span>}
  </>;
}
