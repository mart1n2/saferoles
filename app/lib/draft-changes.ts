import { id as keccak } from "ethers";
import { adoptSignature, isBlankPermission } from "./policy-codec";
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

const withoutPermissions = (role: DraftRole) => ({ ...role, permissions: undefined });

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

/**
 * True when the role differs from the baseline. Its own fields are compared
 * directly; permissions through `permissionChange`, so an ABI decoding a raw
 * condition (which can happen as soon as the list loads) is not an edit.
 */
export function roleChanged(baselineRole: DraftRole | undefined, role: DraftRole): boolean {
  if (!baselineRole) return true;
  const before = baselineRole.permissions;
  const after = role.permissions.filter((permission) => !isBlankPermission(permission));
  if (!same(withoutPermissions(baselineRole), withoutPermissions(role))) return true;
  if (before.length !== after.length) return true;
  if (after.some((permission) => permissionChange(baselineRole, permission) !== null)) return true;
  return before.some((entry) => !after.some((permission) => identity(permission) === identity(entry)));
}

/**
 * True when the draft differs from the baseline in substance. Representation
 * differences (local ids, key order, an ABI decoding a raw condition) and
 * never-started blank permissions are not changes, so they neither count as
 * unsaved edits nor get autosaved for "recovery".
 */
export function policyChanged(baseline: DraftPolicy, draft: DraftPolicy): boolean {
  const { roles: baseRoles, ...baseRest } = baseline;
  const { roles: draftRoles, ...draftRest } = draft;
  if (!same(baseRest, draftRest)) return true;
  if (baseRoles.length !== draftRoles.length) return true;
  return draftRoles.some((role) => roleChanged(baselineRoleFor(baseline, role), role));
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Plain-language list of how a draft differs from the indexed policy, e.g. for a restore notice. */
export function summarizeChanges(baseline: DraftPolicy, draft: DraftPolicy): string[] {
  const lines: string[] = [];
  const draftRoles = draft.roles.filter((role) => baselineRoleFor(baseline, role));
  const addedRoles = draft.roles.length - draftRoles.length;
  const removedRoles = baseline.roles.filter(
    (role) => !draft.roles.some((entry) => baselineRoleFor(baseline, entry) === role),
  ).length;
  if (addedRoles) lines.push(`${plural(addedRoles, "role")} added`);
  if (removedRoles) lines.push(`${plural(removedRoles, "role")} removed`);

  let added = 0;
  let edited = 0;
  let removed = 0;
  let renamed = 0;
  for (const role of draftRoles) {
    const before = baselineRoleFor(baseline, role)!;
    const kept = role.permissions.filter((permission) => !isBlankPermission(permission));
    for (const permission of kept) {
      const change = permissionChange(before, permission);
      if (change === "new") added += 1;
      if (change === "edited") edited += 1;
    }
    removed += before.permissions.filter(
      (entry) => !kept.some((permission) => identity(permission) === identity(entry)),
    ).length;
    if (!same(withoutPermissions(before), withoutPermissions(role))) renamed += 1;
  }
  if (added) lines.push(`${plural(added, "permission")} added`);
  if (edited) lines.push(`${plural(edited, "permission")} edited`);
  if (removed) lines.push(`${plural(removed, "permission")} removed`);
  if (renamed) lines.push(`${plural(renamed, "role")} with changed name, description or members`);

  const baseAllowances = new Map(baseline.allowances.map((entry) => [entry.key, entry]));
  const draftKeys = new Set(draft.allowances.map((entry) => entry.key));
  const allowancesAdded = draft.allowances.filter((entry) => !baseAllowances.has(entry.key)).length;
  const allowancesEdited = draft.allowances.filter(
    (entry) => baseAllowances.has(entry.key) && !same(baseAllowances.get(entry.key), entry),
  ).length;
  const allowancesRemoved = baseline.allowances.filter((entry) => !draftKeys.has(entry.key)).length;
  if (allowancesAdded) lines.push(`${plural(allowancesAdded, "allowance")} added`);
  if (allowancesEdited) lines.push(`${plural(allowancesEdited, "allowance")} edited`);
  if (allowancesRemoved) lines.push(`${plural(allowancesRemoved, "allowance")} removed`);
  return lines;
}
