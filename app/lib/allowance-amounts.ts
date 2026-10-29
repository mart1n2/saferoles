import { formatUnits, parseUnits } from "ethers";
import type { DraftAllowance } from "./policy";
import { encodeKey } from "zodiac-roles-sdk";

export function isExistingAllowance(allowance: DraftAllowance, current: readonly { key: string }[]): boolean {
  try { return current.some((item) => item.key.toLowerCase() === encodeKey(allowance.key.trim()).toLowerCase()); }
  catch { return false; }
}

export function hasCustomInitialBalance(allowance: DraftAllowance): boolean {
  // Older drafts may deliberately start below the ceiling. Never silently top them up.
  return allowance.customInitialBalance ?? allowance.balance !== allowance.maxRefill;
}

export function editAllowanceAmount(allowance: DraftAllowance, field: "balance" | "maxRefill" | "refill", value: string, decimals: number, existing: boolean): DraftAllowance {
  const updated = { ...withAllowanceDecimals(allowance, decimals), [field]: value };
  if (field === "maxRefill" && !existing && !hasCustomInitialBalance(allowance)) updated.balance = value;
  return updated;
}

/** Exact string arithmetic: never round token amounts through a JS number. */
export function allowanceBaseUnits(input: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("Invalid decimals.");
  const value = input.trim();
  if (!/^\d+(?:\.\d*)?$/.test(value) || (value.split(".")[1]?.length ?? 0) > decimals) throw new Error("Invalid amount or precision.");
  const raw = parseUnits(value, decimals);
  if (raw >= 1n << 128n) throw new Error("Amount exceeds uint128.");
  return raw;
}

export function allowanceDisplayAmount(allowance: DraftAllowance, field: "balance" | "maxRefill" | "refill", decimals: number): string {
  if (allowance.amountDecimals === decimals) return allowance[field];
  try {
    const raw = allowanceBaseUnits(allowance[field], allowance.amountDecimals ?? 0);
    return formatUnits(raw, decimals).replace(/\.0$/, "");
  } catch { return allowance[field]; }
}

/** Changing display precision preserves existing on-chain quantities. */
export function withAllowanceDecimals(allowance: DraftAllowance, decimals: number): DraftAllowance {
  return { ...allowance, amountDecimals: decimals,
    balance: allowanceDisplayAmount(allowance, "balance", decimals),
    maxRefill: allowanceDisplayAmount(allowance, "maxRefill", decimals),
    refill: allowanceDisplayAmount(allowance, "refill", decimals) };
}
