import { id as keccak } from "ethers";
import { adoptSignature } from "./policy-codec";
import type { DraftPermission, DraftPolicy, DraftRole } from "./policy";

export type PermissionChange = "new" | "edited" | null;

/**
 * Local ids are counters that restart on every load, so a restored draft and a
 * freshly indexed baseline never share them. Compare content with ids dropped and keys sorted.
 */
// The function is compared through `identity`; signature/selector/label differ
// only because an ABI later fills in what an imported selector lacked.
const IGNORED = new Set(["id", "signature", "signatureLabel", "selector"]);
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .filter(([key, inner]) => !IGNORED.has(key) && inner !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([key, inner]) => [key, canonical(inner)]),
        )
      : value;
// Stored drafts come back with a different key order, so sort keys before comparing.
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * An imported permission carries only a selector until an ABI supplies the
 * signature, so identity uses the selector either way.
 */
const functionSelector = (permission: DraftPermission) => {
  if (permission.signature) return keccak(permission.signature).slice(0, 10);
  return (permission.selector ?? "").toLowerCase();
};

/**
 * A baseline row holds a raw condition tree until an ABI decodes it into
 * editable conditions. Decode it the same way the editor does so opening a
 * permission is not mistaken for editing it.
 */
function samePermission(before: DraftPermission, after: DraftPermission): boolean {
  const comparable =
    before.selector && !before.signature && after.signature
      ? adoptSignature(before, after.signature).permission
      : before;
  return same(comparable, after);
}

/** A permission is the same grant when it targets the same contract and function. */
const identity = (permission: DraftPermission) =>
  [
    permission.targetAddress.trim().toLowerCase(),
    permission.mode,
    permission.mode === "target" ? "" : functionSelector(permission),
  ].join("|");

/** The indexed role this draft role came from; a role added locally has none. */
export function baselineRoleFor(baseline: DraftPolicy | null, role: DraftRole): DraftRole | undefined {
  if (!baseline) return undefined;
  if (role.deployedKey) return baseline.roles.find((entry) => entry.deployedKey === role.deployedKey);
  return baseline.roles.find((entry) => entry.id === role.id);
}

/** Flags only the permission itself: new grant, edited conditions/options, or untouched. */
export function permissionChange(
  baselineRole: DraftRole | undefined,
  permission: DraftPermission,
): PermissionChange {
  const candidates = (baselineRole?.permissions ?? []).filter(
    (entry) => identity(entry) === identity(permission),
  );
  if (candidates.length === 0) return "new";
  return candidates.some((entry) => samePermission(entry, permission)) ? null : "edited";
}

/** True when anything under the role differs from the baseline, including a removed permission. */
export function roleChanged(baselineRole: DraftRole | undefined, role: DraftRole): boolean {
  return !baselineRole || !same(baselineRole, role);
}
