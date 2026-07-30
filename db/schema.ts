/**
 * Drizzle schema mirroring `db/ddl.ts`.
 *
 * Records are scoped by (chainId, rolesMod) rather than by role name, so
 * renaming a role never orphans its history.
 */
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const drafts = sqliteTable(
  "drafts",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    chainId: integer("chain_id").notNull(),
    rolesMod: text("roles_mod").notNull(),
    safeAddress: text("safe_address").notNull(),
    /** Serialized `DraftPolicy`. */
    policy: text("policy").notNull(),
    /**
     * Fingerprint of the on-chain state this draft was forked from. Lets the app
     * detect that the modifier changed underneath a draft — someone else's
     * proposal executed — before a stale diff gets proposed.
     */
    baseStateHash: text("base_state_hash"),
    createdBy: text("created_by"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("drafts_scope").on(table.chainId, table.rolesMod, table.updatedAt)],
);

export const draftRevisions = sqliteTable(
  "draft_revisions",
  {
    id: text("id").primaryKey(),
    draftId: text("draft_id").notNull(),
    policy: text("policy").notNull(),
    note: text("note"),
    author: text("author"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("draft_revisions_draft").on(table.draftId, table.createdAt)],
);

export const proposals = sqliteTable(
  "proposals",
  {
    id: text("id").primaryKey(),
    draftId: text("draft_id"),
    chainId: integer("chain_id").notNull(),
    rolesMod: text("roles_mod").notNull(),
    safeAddress: text("safe_address").notNull(),
    safeTxHash: text("safe_tx_hash").notNull().unique(),
    callCount: integer("call_count").notNull(),
    risk: text("risk").notNull(),
    /** The reviewed diff, as planned calls, exactly as proposed. */
    calls: text("calls").notNull(),
    proposedBy: text("proposed_by"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("proposals_scope").on(table.chainId, table.rolesMod, table.createdAt),
  ],
);

export const contractAbis = sqliteTable(
  "contract_abis",
  {
    chainId: integer("chain_id").notNull(),
    /** Lowercased. */
    address: text("address").notNull(),
    abi: text("abi").notNull(),
    /** `sourcify` | `etherscan` | `manual`. */
    source: text("source").notNull(),
    name: text("name"),
    implementation: text("implementation"),
    proxyType: text("proxy_type"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.chainId, table.address] })],
);

export type DraftRecord = typeof drafts.$inferSelect;
export type ProposalRecord = typeof proposals.$inferSelect;
