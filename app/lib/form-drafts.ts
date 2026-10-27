/**
 * Autosaved, uncommitted form state.
 *
 * These records only protect work the user is still editing: the policy diff,
 * the first-role form of the initialization flow, and the address fields on the
 * Safe picker. They are browser-local convenience data, never chain authority —
 * a restored policy is still diffed against the freshly indexed baseline and
 * goes through the same review and verification as a manual edit.
 *
 * Records are scoped by chain and (where relevant) address, versioned, size
 * bounded and validated on read. A corrupt or mismatched record is discarded
 * instead of being handed to the UI. API keys are deliberately never stored
 * here: they live in the separate encrypted credential envelope.
 */
import { localRead, localUpdate } from "./local-db";
import {
  MAX_DRAFT_BODY_BYTES,
  parse,
  parseDraftPolicy,
  stringify,
} from "./serialize";
import type { DraftPolicy, DraftRole } from "./policy";

const FORM_FORMAT = "saferoles-form";
const FORM_VERSION = 1;
export const MAX_FORM_BYTES = MAX_DRAFT_BODY_BYTES;

/** One key per editable surface, always scoped to where the data belongs. */
export const formKeys = {
  policy: (chainId: number, rolesMod: string) =>
    `policy:${chainId}:${rolesMod.toLowerCase()}`,
  setup: (chainId: number, safeAddress: string) =>
    `setup:${chainId}:${safeAddress.toLowerCase()}`,
  scopeLookup: () => "scope-lookup",
  scopeModifier: () => "scope-modifier",
};

export type PolicyWorkingCopy = {
  policy: DraftPolicy;
  /** Indexed snapshot the edits were made against, if it was known. */
  baseHash: string | null;
};

export type SetupFormState = {
  role: DraftRole;
  memberAddress: string;
  keyEdited: boolean;
  saltNonce: string;
  step: "role" | "review";
};

export type ScopeFormState = { chainId: number; address: string };

export type LoadedForm<T> = { data: T; savedAt: number };

const MAX_ADDRESS_INPUT = 128;
const MAX_INPUT = 4_096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  return value;
}

function allowedKeys(value: Record<string, unknown>, allowed: string[], path: string) {
  const names = new Set(allowed);
  const extra = Object.keys(value).find((name) => !names.has(name));
  if (extra) throw new Error(`${path}.${extra} is not a supported field.`);
}

function text(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string" || value.length > maxLength) {
    throw new Error(`${path} must be a string of at most ${maxLength} characters.`);
  }
  return value;
}

function integer(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${path} must be a positive integer.`);
  }
  return value as number;
}

function baseHash(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error("baseHash must be a SHA-256 hex digest.");
  }
  return value.toLowerCase();
}

/** Validates the autosaved policy diff for one open modifier. */
export function parsePolicyWorkingCopy(
  value: unknown,
  scope: { chainId: number; rolesMod: string },
): PolicyWorkingCopy {
  const row = record(value, "form");
  allowedKeys(row, ["policy", "baseHash"], "form");
  return {
    policy: parseDraftPolicy(row.policy, scope),
    baseHash: baseHash(row.baseHash),
  };
}

/**
 * Validates the initialization form.
 *
 * The first role is structurally a draft role, so it is validated by the same
 * bounded policy parser (wrapped in a single-role policy). Only field structure
 * is enforced here — semantic problems stay visible in the form and in the
 * planner, as they do during editing.
 */
export function parseSetupFormState(
  value: unknown,
  scope: { chainId: number; safeAddress: string },
): SetupFormState {
  const row = record(value, "form");
  allowedKeys(
    row,
    ["role", "memberAddress", "keyEdited", "saltNonce", "step"],
    "form",
  );
  const policy = parseDraftPolicy(
    {
      chainId: scope.chainId,
      rolesMod: scope.safeAddress,
      roles: [row.role],
      allowances: [],
    },
    { chainId: scope.chainId, rolesMod: scope.safeAddress },
  );
  const role = policy.roles[0];
  if (!role) throw new Error("form.role must contain the first role.");
  if (row.step !== "role" && row.step !== "review") {
    throw new Error('form.step must be "role" or "review".');
  }
  if (typeof row.keyEdited !== "boolean") {
    throw new Error("form.keyEdited must be a boolean.");
  }
  const saltNonce = text(row.saltNonce, "form.saltNonce", 78);
  if (!/^\d*$/.test(saltNonce)) {
    throw new Error("form.saltNonce must contain digits only.");
  }
  return {
    role,
    memberAddress: text(row.memberAddress, "form.memberAddress", MAX_INPUT),
    keyEdited: row.keyEdited,
    saltNonce,
    step: row.step,
  };
}

/** Validates the chain/address fields on the Safe picker. */
export function parseScopeFormState(value: unknown): ScopeFormState {
  const row = record(value, "form");
  allowedKeys(row, ["chainId", "address"], "form");
  return {
    chainId: integer(row.chainId, "form.chainId"),
    address: text(row.address, "form.address", MAX_ADDRESS_INPUT),
  };
}

/**
 * Reads one autosaved form.
 *
 * Storage errors and rejected records both resolve to `null`: autosave is a
 * convenience, so a browser that denies storage must not break editing. A
 * record that is corrupt or no longer belongs to `key` is removed rather than
 * retried on every visit.
 */
export async function readSavedForm<T>(
  key: string,
  readData: (value: unknown) => T,
): Promise<LoadedForm<T> | null> {
  let raw: string | undefined;
  try {
    raw = await localRead<string>("forms", key);
  } catch {
    return null;
  }
  let envelope: unknown;
  try {
    envelope = raw === undefined ? null : parse<unknown>(raw);
  } catch {
    envelope = null;
  }
  const row = isRecord(envelope) ? envelope : null;
  const valid =
    row !== null &&
    row.format === FORM_FORMAT &&
    row.version === FORM_VERSION &&
    row.key === key &&
    typeof row.savedAt === "number" &&
    Number.isFinite(row.savedAt);
  if (!valid) {
    await clearSavedForm(key);
    return null;
  }
  try {
    return {
      data: readData(row.data),
      savedAt: row.savedAt as number,
    };
  } catch {
    await clearSavedForm(key);
    return null;
  }
}

/**
 * Writes one autosaved form and returns its timestamp.
 *
 * Throws only for an oversized value; the caller decides whether a storage
 * failure is worth surfacing, because it must never block editing.
 */
export async function writeSavedForm<T>(key: string, data: T): Promise<number> {
  const savedAt = Date.now();
  const payload = stringify({
    format: FORM_FORMAT,
    version: FORM_VERSION,
    key,
    savedAt,
    data,
  });
  if (new TextEncoder().encode(payload).length > MAX_FORM_BYTES) {
    throw new Error("Autosaved form exceeds 2 MB. Export your work as a draft instead.");
  }
  await localUpdate<string>("forms", key, () => payload);
  return savedAt;
}

/** Removes an autosaved form. Failures are ignored: there is nothing to repair. */
export async function clearSavedForm(key: string): Promise<void> {
  try {
    await localUpdate<string>("forms", key, () => undefined);
  } catch {
    // A browser that denies storage has no record to remove.
  }
}

/** True when a restored policy differs from the freshly indexed snapshot. */
export function isRecoveredPolicyChange(
  restored: PolicyWorkingCopy,
  baseline: DraftPolicy,
): boolean {
  return stringify(restored.policy) !== stringify(baseline);
}

/** True when a restored working copy was based on a different indexed snapshot. */
export function isRecoveredPolicyStale(
  restored: { baseHash: string | null },
  currentBaseHash: string | null,
): boolean {
  return Boolean(
    restored.baseHash && currentBaseHash && restored.baseHash !== currentBaseHash,
  );
}
