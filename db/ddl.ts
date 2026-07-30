/**
 * Executable D1 schema.
 *
 * `0000_init.sql` is retained byte-for-byte as the legacy bootstrap migration.
 * Authenticated persistence uses isolated v2 tables because the anonymous v1
 * rows have no trustworthy owner to migrate. Existing deployments apply
 * `0001_authenticated_persistence.sql`; local development lazily creates the
 * same v2 tables through {@link SCHEMA_STATEMENTS}.
 */

const INITIAL_SCHEMA_STATEMENTS: readonly string[] = [
  `create table if not exists drafts (
  id text primary key,
  name text not null,
  chain_id integer not null,
  roles_mod text not null,
  safe_address text not null,
  policy text not null,
  base_state_hash text,
  created_by text,
  created_at integer not null,
  updated_at integer not null
)`,
  `create index if not exists drafts_scope on drafts (chain_id, roles_mod, updated_at)`,

  `create table if not exists draft_revisions (
  id text primary key,
  draft_id text not null references drafts(id) on delete cascade,
  policy text not null,
  note text,
  author text,
  created_at integer not null
)`,
  `create index if not exists draft_revisions_draft on draft_revisions (draft_id, created_at)`,

  `create table if not exists proposals (
  id text primary key,
  draft_id text,
  chain_id integer not null,
  roles_mod text not null,
  safe_address text not null,
  safe_tx_hash text not null unique,
  call_count integer not null,
  risk text not null,
  calls text not null,
  proposed_by text,
  created_at integer not null
)`,
  `create index if not exists proposals_scope on proposals (chain_id, roles_mod, created_at)`,

  `create table if not exists contract_abis (
  chain_id integer not null,
  address text not null,
  abi text not null,
  source text not null,
  name text,
  implementation text,
  proxy_type text,
  updated_at integer not null,
  primary key (chain_id, address)
)`,
];

/** Current authenticated schema, also used by local lazy bootstrap. */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `create table if not exists drafts_v2 (
  id text primary key,
  tenant_id text not null,
  name text not null,
  chain_id integer not null,
  roles_mod text not null,
  safe_address text not null,
  policy text not null,
  base_state_hash text,
  created_by text not null,
  version integer not null default 1 check (version >= 1),
  created_at integer not null,
  updated_at integer not null
)`,
  `create index if not exists drafts_v2_scope on drafts_v2 (tenant_id, chain_id, roles_mod, updated_at)`,

  `create table if not exists draft_revisions_v2 (
  id text primary key,
  tenant_id text not null,
  draft_id text not null references drafts_v2(id) on delete cascade,
  version integer not null check (version >= 1),
  policy text not null,
  note text,
  author text not null,
  created_at integer not null
)`,
  `create unique index if not exists draft_revisions_v2_draft_version on draft_revisions_v2 (draft_id, version)`,
  `create index if not exists draft_revisions_v2_draft on draft_revisions_v2 (tenant_id, draft_id, version)`,

  `create table if not exists proposals_v2 (
  id text primary key,
  tenant_id text not null,
  draft_id text,
  chain_id integer not null,
  roles_mod text not null,
  safe_address text not null,
  reference_kind text not null check (reference_kind in ('safeTxHash', 'bundleId', 'txHashes')),
  reference_key text not null,
  submission text not null,
  call_count integer not null check (call_count >= 0),
  risk text not null check (risk in ('Low', 'Medium', 'High', 'Critical')),
  calls text not null,
  proposed_by text not null,
  created_at integer not null
)`,
  `create unique index if not exists proposals_v2_tenant_reference on proposals_v2 (tenant_id, reference_key)`,
  `create index if not exists proposals_v2_scope on proposals_v2 (tenant_id, chain_id, roles_mod, created_at)`,

  `create table if not exists contract_abis_v2 (
  tenant_id text not null,
  chain_id integer not null,
  address text not null,
  abi text not null,
  source text not null check (source in ('sourcify', 'etherscan', 'manual')),
  name text,
  implementation text,
  proxy_type text,
  refreshed_at integer not null,
  expires_at integer,
  updated_at integer not null,
  primary key (tenant_id, chain_id, address)
)`,
  `create index if not exists contract_abis_v2_expiry on contract_abis_v2 (tenant_id, expires_at)`,
];

export const SCHEMA_SQL = `${INITIAL_SCHEMA_STATEMENTS.join(";\n\n")};\n`;
export const AUTHENTICATED_SCHEMA_SQL = `${SCHEMA_STATEMENTS.join(";\n\n")};\n`;

export const SQL_FILE_PATH = "drizzle/0000_init.sql";
export const AUTHENTICATED_SQL_FILE_PATH =
  "drizzle/0001_authenticated_persistence.sql";

export const SQL_FILE_HEADER =
  "-- Generated from db/ddl.ts. Do not edit by hand.\n-- Regenerate with: npm run db:generate\n\n";

export const AUTHENTICATED_SQL_FILE_HEADER =
  "-- Authenticated persistence migration generated from db/ddl.ts.\n" +
  "-- Anonymous v1 rows are intentionally not migrated because they have no trusted owner.\n\n";
