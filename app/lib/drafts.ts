/**
 * Draft and proposal storage.
 *
 * Every record is scoped to a (chainId, rolesMod) pair. Drafts hold the edited
 * policy; proposals hold the diff that was actually submitted, which is the
 * audit trail that survives renames and page reloads.
 */
import { and, desc, eq } from "drizzle-orm";
import { getClient, schema } from "../../db/client";
import type { DraftPolicy } from "./policy";
import type { Call } from "zodiac-roles-sdk";
import { stringify, parse } from "./serialize";

export type DraftSummary = {
  id: string;
  name: string;
  chainId: number;
  rolesMod: string;
  safeAddress: string;
  baseStateHash: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
};

export type Draft = DraftSummary & { policy: DraftPolicy };

function now(): number {
  return Date.now();
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Fingerprints the on-chain state a draft was based on.
 *
 * Used to warn when the modifier has changed since the draft was created, so a
 * diff computed against stale state is never proposed silently.
 */
export async function stateFingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function toSummary(row: typeof schema.drafts.$inferSelect): DraftSummary {
  return {
    id: row.id,
    name: row.name,
    chainId: row.chainId,
    rolesMod: row.rolesMod,
    safeAddress: row.safeAddress,
    baseStateHash: row.baseStateHash,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listDrafts(
  chainId: number,
  rolesMod: string,
): Promise<DraftSummary[]> {
  const client = await getClient();
  const rows = await client
    .select()
    .from(schema.drafts)
    .where(
      and(
        eq(schema.drafts.chainId, chainId),
        eq(schema.drafts.rolesMod, normalizeAddress(rolesMod)),
      ),
    )
    .orderBy(desc(schema.drafts.updatedAt));
  return rows.map(toSummary);
}

export async function getDraft(draftId: string): Promise<Draft | null> {
  const client = await getClient();
  const [row] = await client
    .select()
    .from(schema.drafts)
    .where(eq(schema.drafts.id, draftId))
    .limit(1);
  if (!row) return null;
  return { ...toSummary(row), policy: parse<DraftPolicy>(row.policy) };
}

export async function createDraft(input: {
  name: string;
  chainId: number;
  rolesMod: string;
  safeAddress: string;
  policy: DraftPolicy;
  baseStateHash?: string | null;
  createdBy?: string | null;
}): Promise<Draft> {
  const client = await getClient();
  const timestamp = now();
  const row = {
    id: id("draft"),
    name: input.name.trim() || "Untitled draft",
    chainId: input.chainId,
    rolesMod: normalizeAddress(input.rolesMod),
    safeAddress: normalizeAddress(input.safeAddress),
    policy: stringify(input.policy),
    baseStateHash: input.baseStateHash ?? null,
    createdBy: input.createdBy ? normalizeAddress(input.createdBy) : null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await client.insert(schema.drafts).values(row);
  await client.insert(schema.draftRevisions).values({
    id: id("rev"),
    draftId: row.id,
    policy: row.policy,
    note: "Created",
    author: row.createdBy,
    createdAt: timestamp,
  });
  return { ...toSummary(row), policy: input.policy };
}

export async function saveDraft(input: {
  draftId: string;
  policy: DraftPolicy;
  name?: string;
  note?: string | null;
  author?: string | null;
  baseStateHash?: string | null;
}): Promise<Draft | null> {
  const client = await getClient();
  const existing = await getDraft(input.draftId);
  if (!existing) return null;

  const timestamp = now();
  const policy = stringify(input.policy);
  await client
    .update(schema.drafts)
    .set({
      policy,
      name: input.name?.trim() || existing.name,
      baseStateHash: input.baseStateHash ?? existing.baseStateHash,
      updatedAt: timestamp,
    })
    .where(eq(schema.drafts.id, input.draftId));

  // Keep a revision per save so a policy change can be traced back.
  await client.insert(schema.draftRevisions).values({
    id: id("rev"),
    draftId: input.draftId,
    policy,
    note: input.note ?? null,
    author: input.author ? normalizeAddress(input.author) : null,
    createdAt: timestamp,
  });

  return {
    ...existing,
    name: input.name?.trim() || existing.name,
    policy: input.policy,
    updatedAt: timestamp,
  };
}

export async function deleteDraft(draftId: string): Promise<void> {
  const client = await getClient();
  await client
    .delete(schema.draftRevisions)
    .where(eq(schema.draftRevisions.draftId, draftId));
  await client.delete(schema.drafts).where(eq(schema.drafts.id, draftId));
}

export type ProposalInput = {
  draftId?: string | null;
  chainId: number;
  rolesMod: string;
  safeAddress: string;
  safeTxHash: string;
  risk: string;
  calls: Call[];
  proposedBy?: string | null;
};

export async function recordProposal(input: ProposalInput): Promise<void> {
  const client = await getClient();
  await client
    .insert(schema.proposals)
    .values({
      id: id("proposal"),
      draftId: input.draftId ?? null,
      chainId: input.chainId,
      rolesMod: normalizeAddress(input.rolesMod),
      safeAddress: normalizeAddress(input.safeAddress),
      safeTxHash: input.safeTxHash,
      callCount: input.calls.length,
      risk: input.risk,
      calls: stringify(input.calls),
      proposedBy: input.proposedBy ? normalizeAddress(input.proposedBy) : null,
      createdAt: now(),
    })
    // Re-proposing the same Safe transaction must not create a duplicate row.
    .onConflictDoNothing({ target: schema.proposals.safeTxHash });
}

export type ProposalSummary = {
  id: string;
  safeTxHash: string;
  callCount: number;
  risk: string;
  calls: Call[];
  proposedBy: string | null;
  createdAt: number;
};

export async function listProposals(
  chainId: number,
  rolesMod: string,
  limit = 25,
): Promise<ProposalSummary[]> {
  const client = await getClient();
  const rows = await client
    .select()
    .from(schema.proposals)
    .where(
      and(
        eq(schema.proposals.chainId, chainId),
        eq(schema.proposals.rolesMod, normalizeAddress(rolesMod)),
      ),
    )
    .orderBy(desc(schema.proposals.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    safeTxHash: row.safeTxHash,
    callCount: row.callCount,
    risk: row.risk,
    calls: parse<Call[]>(row.calls),
    proposedBy: row.proposedBy,
    createdAt: row.createdAt,
  }));
}
