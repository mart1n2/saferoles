/**
 * The database schema, as executable statements.
 *
 * This is the single source of truth for the schema. `drizzle/0000_init.sql` is
 * generated from it for the hosted migration pipeline, and `ensureSchema()`
 * applies it lazily so local development and tests need no separate step.
 * A test asserts the two stay identical.
 */

export const SCHEMA_STATEMENTS: readonly string[] = [
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

  // Resolved and manually-entered ABIs, keyed by chain and address. A manual
  // entry is authoritative: someone supplied it because no source had the
  // contract verified, so it must never be overwritten by a later lookup.
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

export const SCHEMA_SQL = `${SCHEMA_STATEMENTS.join(";\n\n")};\n`;

export const SQL_FILE_PATH = "drizzle/0000_init.sql";

export const SQL_FILE_HEADER =
  "-- Generated from db/ddl.ts. Do not edit by hand.\n-- Regenerate with: npm run db:generate\n\n";
