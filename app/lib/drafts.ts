/**
 * Authenticated draft and proposal persistence.
 *
 * Tenant identity is always supplied by the trusted hosting authentication
 * boundary. Scope is immutable, saves use optimistic versions, and each draft
 * mutation plus its revision is committed in one D1 batch.
 */
import { and, desc, eq } from "drizzle-orm";
import type { Call } from "zodiac-roles-sdk";
import type { PersistenceActor } from "../chatgpt-auth";
import { getClient, getDatabase, schema } from "../../db/client";
import type { DraftPolicy } from "./policy";
import {
  parse,
  parseCalls,
  parseDraftPolicy,
  parseProposalSubmission,
  stringify,
  type ProposalSubmission,
} from "./serialize";

export const MAX_DRAFTS_PER_SCOPE = 100;
export const MAX_PROPOSALS_PER_SCOPE = 100;

export class DraftVersionConflictError extends Error {
  readonly currentVersion: number | null;

  constructor(currentVersion: number | null) {
    super(
      currentVersion === null
        ? "The draft no longer exists."
        : `The draft changed since it was opened (current version ${currentVersion}).`,
    );
    this.name = "DraftVersionConflictError";
    this.currentVersion = currentVersion;
  }
}

export class ProposalConflictError extends Error {
  constructor() {
    super("That submission reference is already recorded with different details.");
    this.name = "ProposalConflictError";
  }
}

export type DraftScope = {
  chainId: number;
  rolesMod: string;
};

export type DraftSummary = DraftScope & {
  id: string;
  name: string;
  safeAddress: string;
  baseStateHash: string | null;
  createdBy: string;
  version: number;
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

function affectedRows(result: unknown): number | null {
  if (!result || typeof result !== "object") return null;
  const meta = (result as { meta?: unknown }).meta;
  if (!meta || typeof meta !== "object") return null;
  const changes = (meta as { changes?: unknown }).changes;
  return typeof changes === "number" && Number.isSafeInteger(changes)
    ? changes
    : null;
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
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDraft(row: typeof schema.drafts.$inferSelect): Draft {
  const policy = parseDraftPolicy(parse<unknown>(row.policy), {
    chainId: row.chainId,
    rolesMod: row.rolesMod,
  });
  return { ...toSummary(row), policy };
}

/**
 * Fingerprints a canonical state. Kept server-side for callers that need to
 * independently compare the current indexed state before accepting a save.
 */
export async function stateFingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function listDrafts(
  actor: PersistenceActor,
  chainId: number,
  rolesMod: string,
  limit = MAX_DRAFTS_PER_SCOPE,
): Promise<DraftSummary[]> {
  const client = await getClient();
  const rows = await client
    .select()
    .from(schema.drafts)
    .where(
      and(
        eq(schema.drafts.tenantId, actor.tenantId),
        eq(schema.drafts.chainId, chainId),
        eq(schema.drafts.rolesMod, normalizeAddress(rolesMod)),
      ),
    )
    .orderBy(desc(schema.drafts.updatedAt))
    .limit(Math.min(Math.max(limit, 1), MAX_DRAFTS_PER_SCOPE));
  return rows.map(toSummary);
}

export async function getDraft(
  actor: PersistenceActor,
  draftId: string,
  scope: DraftScope,
): Promise<Draft | null> {
  const client = await getClient();
  const [row] = await client
    .select()
    .from(schema.drafts)
    .where(
      and(
        eq(schema.drafts.id, draftId),
        eq(schema.drafts.tenantId, actor.tenantId),
        eq(schema.drafts.chainId, scope.chainId),
        eq(schema.drafts.rolesMod, normalizeAddress(scope.rolesMod)),
      ),
    )
    .limit(1);
  return row ? toDraft(row) : null;
}

export async function createDraft(
  actor: PersistenceActor,
  input: {
    name: string;
    chainId: number;
    rolesMod: string;
    safeAddress: string;
    policy: DraftPolicy;
    baseStateHash?: string | null;
  },
): Promise<Draft> {
  const database = await getDatabase();
  const timestamp = now();
  const draftId = id("draft");
  const revisionId = id("rev");
  const rolesMod = normalizeAddress(input.rolesMod);
  const safeAddress = normalizeAddress(input.safeAddress);
  const policy = parseDraftPolicy(input.policy, {
    chainId: input.chainId,
    rolesMod,
  });
  const serializedPolicy = stringify(policy);
  const name = input.name.trim() || "Untitled draft";

  await database.batch([
    database
      .prepare(
        `insert into drafts_v2
          (id, tenant_id, name, chain_id, roles_mod, safe_address, policy,
           base_state_hash, created_by, version, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .bind(
        draftId,
        actor.tenantId,
        name,
        input.chainId,
        rolesMod,
        safeAddress,
        serializedPolicy,
        input.baseStateHash ?? null,
        actor.email,
        timestamp,
        timestamp,
      ),
    database
      .prepare(
        `insert into draft_revisions_v2
          (id, tenant_id, draft_id, version, policy, note, author, created_at)
         values (?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .bind(
        revisionId,
        actor.tenantId,
        draftId,
        serializedPolicy,
        "Created",
        actor.email,
        timestamp,
      ),
  ]);

  return {
    id: draftId,
    name,
    chainId: input.chainId,
    rolesMod,
    safeAddress,
    policy,
    baseStateHash: input.baseStateHash ?? null,
    createdBy: actor.email,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export async function saveDraft(
  actor: PersistenceActor,
  input: {
    draftId: string;
    chainId: number;
    rolesMod: string;
    version: number;
    policy: DraftPolicy;
    name?: string;
    note?: string | null;
    baseStateHash?: string | null;
  },
): Promise<Draft | null> {
  const scope = { chainId: input.chainId, rolesMod: input.rolesMod };
  const existing = await getDraft(actor, input.draftId, scope);
  if (!existing) return null;
  if (existing.version !== input.version) {
    throw new DraftVersionConflictError(existing.version);
  }

  const database = await getDatabase();
  const timestamp = now();
  const nextVersion = input.version + 1;
  const rolesMod = normalizeAddress(input.rolesMod);
  const policy = parseDraftPolicy(input.policy, {
    chainId: input.chainId,
    rolesMod,
  });
  const serializedPolicy = stringify(policy);
  const name = input.name?.trim() || existing.name;
  const hash =
    input.baseStateHash === undefined ? existing.baseStateHash : input.baseStateHash;

  // The revision SELECT and the update share the same version predicate. D1
  // executes a batch transactionally, so either both observe the row or neither
  // does; a concurrent saver cannot leave history and current state out of sync.
  const results = await database.batch([
    database
      .prepare(
        `insert into draft_revisions_v2
          (id, tenant_id, draft_id, version, policy, note, author, created_at)
         select ?, tenant_id, id, ?, ?, ?, ?, ?
           from drafts_v2
          where id = ? and tenant_id = ? and chain_id = ? and roles_mod = ? and version = ?`,
      )
      .bind(
        id("rev"),
        nextVersion,
        serializedPolicy,
        input.note ?? null,
        actor.email,
        timestamp,
        input.draftId,
        actor.tenantId,
        input.chainId,
        rolesMod,
        input.version,
      ),
    database
      .prepare(
        `update drafts_v2
            set policy = ?, name = ?, base_state_hash = ?, version = ?, updated_at = ?
          where id = ? and tenant_id = ? and chain_id = ? and roles_mod = ? and version = ?`,
      )
      .bind(
        serializedPolicy,
        name,
        hash,
        nextVersion,
        timestamp,
        input.draftId,
        actor.tenantId,
        input.chainId,
        rolesMod,
        input.version,
      ),
  ]);

  // D1 reports per-statement changes for a batch. Reading the row after the
  // batch is not enough: a losing concurrent saver would otherwise see the
  // winner's version and could incorrectly report its own write as successful.
  const revisionChanges = affectedRows(results[0]);
  const draftChanges = affectedRows(results[1]);
  if (revisionChanges !== 1 || draftChanges !== 1) {
    const current = await getDraft(actor, input.draftId, scope);
    throw new DraftVersionConflictError(current?.version ?? null);
  }

  // Return this committed version directly. A second legitimate save may
  // advance the row again immediately after our batch; a post-write read would
  // then falsely report that this already-committed update had failed.
  return {
    ...existing,
    name,
    policy,
    baseStateHash: hash,
    version: nextVersion,
    updatedAt: timestamp,
  };
}

export async function deleteDraft(
  actor: PersistenceActor,
  draftId: string,
  scope: DraftScope,
  version: number,
): Promise<boolean> {
  const existing = await getDraft(actor, draftId, scope);
  if (!existing) return false;
  if (existing.version !== version) {
    throw new DraftVersionConflictError(existing.version);
  }

  const database = await getDatabase();
  const result = await database
    .prepare(
      `delete from drafts_v2
        where id = ? and tenant_id = ? and chain_id = ? and roles_mod = ? and version = ?`,
    )
    .bind(
      draftId,
      actor.tenantId,
      scope.chainId,
      normalizeAddress(scope.rolesMod),
      version,
    )
    .run();

  if (affectedRows(result) !== 1) {
    const current = await getDraft(actor, draftId, scope);
    throw new DraftVersionConflictError(current?.version ?? null);
  }

  return true;
}

export type ProposalInput = {
  draftId?: string | null;
  chainId: number;
  rolesMod: string;
  safeAddress: string;
  submission: ProposalSubmission;
  risk: "Low" | "Medium" | "High" | "Critical";
  calls: Call[];
};

async function referenceKey(submission: ProposalSubmission): Promise<string> {
  return `${submission.kind}:${await stateFingerprint(submission)}`;
}

function proposalMatches(
  row: typeof schema.proposals.$inferSelect,
  candidate: {
    draftId: string | null;
    chainId: number;
    rolesMod: string;
    safeAddress: string;
    referenceKind: ProposalSubmission["kind"];
    submission: string;
    callCount: number;
    risk: ProposalInput["risk"];
    calls: string;
    proposedBy: string;
  },
): boolean {
  return (
    row.draftId === candidate.draftId &&
    row.chainId === candidate.chainId &&
    row.rolesMod === candidate.rolesMod &&
    row.safeAddress === candidate.safeAddress &&
    row.referenceKind === candidate.referenceKind &&
    row.submission === candidate.submission &&
    row.callCount === candidate.callCount &&
    row.risk === candidate.risk &&
    row.calls === candidate.calls &&
    row.proposedBy === candidate.proposedBy
  );
}

export async function recordProposal(
  actor: PersistenceActor,
  input: ProposalInput,
): Promise<{ created: boolean }> {
  const client = await getClient();
  const rolesMod = normalizeAddress(input.rolesMod);
  const safeAddress = normalizeAddress(input.safeAddress);
  const submission = parseProposalSubmission(input.submission);
  const calls = parseCalls(input.calls);

  if (input.draftId) {
    const draft = await getDraft(actor, input.draftId, {
      chainId: input.chainId,
      rolesMod,
    });
    if (!draft) {
      throw new ProposalConflictError();
    }
  }

  const canonical = {
    draftId: input.draftId ?? null,
    chainId: input.chainId,
    rolesMod,
    safeAddress,
    referenceKind: submission.kind,
    submission: stringify(submission),
    callCount: calls.length,
    risk: input.risk,
    calls: stringify(calls),
    proposedBy: actor.email,
  } as const;
  const key = await referenceKey(submission);
  const proposalId = id("proposal");

  const inserted = await client
    .insert(schema.proposals)
    .values({
      id: proposalId,
      tenantId: actor.tenantId,
      ...canonical,
      referenceKey: key,
      createdAt: now(),
    })
    .onConflictDoNothing({
      target: [schema.proposals.tenantId, schema.proposals.referenceKey],
    })
    .returning({ id: schema.proposals.id });

  if (inserted.length > 0) return { created: true };

  const [existing] = await client
    .select()
    .from(schema.proposals)
    .where(
      and(
        eq(schema.proposals.tenantId, actor.tenantId),
        eq(schema.proposals.referenceKey, key),
      ),
    )
    .limit(1);
  if (!existing || !proposalMatches(existing, canonical)) {
    throw new ProposalConflictError();
  }
  return { created: false };
}

export type ProposalSummary = {
  id: string;
  draftId: string | null;
  chainId: number;
  rolesMod: string;
  safeAddress: string;
  submission: ProposalSubmission;
  callCount: number;
  risk: "Low" | "Medium" | "High" | "Critical";
  calls: Call[];
  proposedBy: string;
  createdAt: number;
};

export async function listProposals(
  actor: PersistenceActor,
  chainId: number,
  rolesMod: string,
  limit = 25,
): Promise<{ proposals: ProposalSummary[]; corruptRecords: number }> {
  const client = await getClient();
  const rows = await client
    .select()
    .from(schema.proposals)
    .where(
      and(
        eq(schema.proposals.tenantId, actor.tenantId),
        eq(schema.proposals.chainId, chainId),
        eq(schema.proposals.rolesMod, normalizeAddress(rolesMod)),
      ),
    )
    .orderBy(desc(schema.proposals.createdAt))
    .limit(Math.min(Math.max(limit, 1), MAX_PROPOSALS_PER_SCOPE));

  const proposals: ProposalSummary[] = [];
  let corruptRecords = 0;
  for (const row of rows) {
    try {
      const submission = parseProposalSubmission(parse<unknown>(row.submission));
      const calls = parseCalls(parse<unknown>(row.calls));
      if (
        submission.kind !== row.referenceKind ||
        calls.length !== row.callCount ||
        (row.risk !== "Low" &&
          row.risk !== "Medium" &&
          row.risk !== "High" &&
          row.risk !== "Critical")
      ) {
        throw new Error("Stored proposal metadata does not match its payload.");
      }
      proposals.push({
        id: row.id,
        draftId: row.draftId,
        chainId: row.chainId,
        rolesMod: row.rolesMod,
        safeAddress: row.safeAddress,
        submission,
        callCount: calls.length,
        risk: row.risk,
        calls,
        proposedBy: row.proposedBy,
        createdAt: row.createdAt,
      });
    } catch {
      // One legacy/corrupt row must not make the entire Activity view unavailable.
      corruptRecords += 1;
    }
  }
  return { proposals, corruptRecords };
}
