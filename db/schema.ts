/**
 * Authenticated Drizzle schema mirroring `db/ddl.ts`.
 *
 * Anonymous v1 tables remain only as a legacy migration artifact. Application
 * code exclusively uses these tenant-scoped v2 tables.
 */
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const drafts = sqliteTable(
  "drafts_v2",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    chainId: integer("chain_id").notNull(),
    rolesMod: text("roles_mod").notNull(),
    safeAddress: text("safe_address").notNull(),
    /** Serialized and structurally validated `DraftPolicy`. */
    policy: text("policy").notNull(),
    baseStateHash: text("base_state_hash"),
    createdBy: text("created_by").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("drafts_v2_scope").on(
      table.tenantId,
      table.chainId,
      table.rolesMod,
      table.updatedAt,
    ),
  ],
);

export const draftRevisions = sqliteTable(
  "draft_revisions_v2",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    draftId: text("draft_id")
      .notNull()
      .references(() => drafts.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    policy: text("policy").notNull(),
    note: text("note"),
    author: text("author").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("draft_revisions_v2_draft_version").on(table.draftId, table.version),
    index("draft_revisions_v2_draft").on(table.tenantId, table.draftId, table.version),
  ],
);

export const proposals = sqliteTable(
  "proposals_v2",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    draftId: text("draft_id"),
    chainId: integer("chain_id").notNull(),
    rolesMod: text("roles_mod").notNull(),
    safeAddress: text("safe_address").notNull(),
    referenceKind: text("reference_kind", {
      enum: ["safeTxHash", "bundleId", "txHashes"],
    }).notNull(),
    /** SHA-256 of the canonical typed submission, prefixed by its kind. */
    referenceKey: text("reference_key").notNull(),
    submission: text("submission").notNull(),
    callCount: integer("call_count").notNull(),
    risk: text("risk", { enum: ["Low", "Medium", "High", "Critical"] }).notNull(),
    /** The reviewed diff, exactly as reported after submission. */
    calls: text("calls").notNull(),
    proposedBy: text("proposed_by").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("proposals_v2_tenant_reference").on(
      table.tenantId,
      table.referenceKey,
    ),
    index("proposals_v2_scope").on(
      table.tenantId,
      table.chainId,
      table.rolesMod,
      table.createdAt,
    ),
  ],
);

export const contractAbis = sqliteTable(
  "contract_abis_v2",
  {
    /**
     * Manual entries use the authenticated tenant. Verified-source cache entries
     * use the reserved public-cache tenant and can never overwrite a manual row.
     */
    tenantId: text("tenant_id").notNull(),
    chainId: integer("chain_id").notNull(),
    /** Lowercased. */
    address: text("address").notNull(),
    abi: text("abi").notNull(),
    source: text("source", { enum: ["sourcify", "etherscan", "manual"] }).notNull(),
    name: text("name"),
    implementation: text("implementation"),
    proxyType: text("proxy_type"),
    refreshedAt: integer("refreshed_at").notNull(),
    /** Null only for authoritative manual entries. */
    expiresAt: integer("expires_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.chainId, table.address] }),
    index("contract_abis_v2_expiry").on(table.tenantId, table.expiresAt),
  ],
);

export type DraftRecord = typeof drafts.$inferSelect;
export type ProposalRecord = typeof proposals.$inferSelect;
