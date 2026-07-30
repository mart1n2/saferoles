/**
 * Tenant-owned manual ABIs plus a short-lived public verified-source cache.
 *
 * Manual and automatic rows use different tenant keys, so an automatic refresh
 * cannot overwrite a user's authoritative entry. The SQL upsert also protects a
 * manual row atomically as defense in depth.
 */
import { and, eq, gt } from "drizzle-orm";
import { getClient, getDatabase, schema } from "../../db/client";
import { getDatabaseBinding } from "./db-binding";
import {
  describeFunctions,
  type AbiSource,
  type ResolvedAbi,
} from "./abi-source";

const PUBLIC_CACHE_TENANT = "__verified_source_cache__";
const VERIFIED_ABI_TTL_MS = 15 * 60 * 1_000;

function key(address: string): string {
  return address.trim().toLowerCase();
}

function decodeRow(
  row: typeof schema.contractAbis.$inferSelect,
  requestedAddress: string,
): ResolvedAbi {
  const parsed = JSON.parse(row.abi) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Stored ABI is not an array.");
  const functions = describeFunctions(parsed);
  if (functions.length === 0) throw new Error("Stored ABI declares no functions.");
  return {
    chainId: row.chainId,
    address: requestedAddress,
    source: row.source as AbiSource,
    name: row.name,
    implementation: row.implementation,
    proxyType: row.proxyType,
    functions,
    abi: parsed,
  };
}

/**
 * Reads this tenant's manual ABI first, then an unexpired public verified ABI.
 * With no D1 binding the caller simply performs a live source lookup.
 */
export async function readStoredAbi(
  chainId: number,
  address: string,
  tenantId?: string,
): Promise<ResolvedAbi | null> {
  if (!getDatabaseBinding()) return null;
  const client = await getClient();
  const normalized = key(address);

  if (tenantId) {
    const [manual] = await client
      .select()
      .from(schema.contractAbis)
      .where(
        and(
          eq(schema.contractAbis.tenantId, tenantId),
          eq(schema.contractAbis.chainId, chainId),
          eq(schema.contractAbis.address, normalized),
          eq(schema.contractAbis.source, "manual"),
        ),
      )
      .limit(1);
    if (manual) return decodeRow(manual, address);
  }

  const [cached] = await client
    .select()
    .from(schema.contractAbis)
    .where(
      and(
        eq(schema.contractAbis.tenantId, PUBLIC_CACHE_TENANT),
        eq(schema.contractAbis.chainId, chainId),
        eq(schema.contractAbis.address, normalized),
        gt(schema.contractAbis.expiresAt, Date.now()),
      ),
    )
    .limit(1);
  return cached ? decodeRow(cached, address) : null;
}

/**
 * Stores an ABI and propagates failures to the caller.
 *
 * Manual writes require an authenticated tenant. Verified-source writes use the
 * public cache tenant and expire quickly so proxy upgrades are re-resolved.
 */
export async function writeStoredAbi(
  resolved: ResolvedAbi,
  tenantId?: string,
): Promise<void> {
  if (resolved.source === "manual" && !tenantId) {
    throw new Error("An authenticated tenant is required to store a manual ABI.");
  }

  const database = await getDatabase();
  const timestamp = Date.now();
  const rowTenant =
    resolved.source === "manual" ? (tenantId as string) : PUBLIC_CACHE_TENANT;
  const expiresAt =
    resolved.source === "manual" ? null : timestamp + VERIFIED_ABI_TTL_MS;

  await database
    .prepare(
      `insert into contract_abis_v2
        (tenant_id, chain_id, address, abi, source, name, implementation,
         proxy_type, refreshed_at, expires_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (tenant_id, chain_id, address) do update set
         abi = excluded.abi,
         source = excluded.source,
         name = excluded.name,
         implementation = excluded.implementation,
         proxy_type = excluded.proxy_type,
         refreshed_at = excluded.refreshed_at,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at
       where contract_abis_v2.source <> 'manual' or excluded.source = 'manual'`,
    )
    .bind(
      rowTenant,
      resolved.chainId,
      key(resolved.address),
      JSON.stringify(resolved.abi),
      resolved.source,
      resolved.name,
      resolved.implementation,
      resolved.proxyType,
      timestamp,
      expiresAt,
      timestamp,
    )
    .run();
}

/** Deletes only this authenticated tenant's manual override. */
export async function forgetStoredAbi(
  chainId: number,
  address: string,
  tenantId: string,
): Promise<boolean> {
  const client = await getClient();
  const predicate = and(
    eq(schema.contractAbis.tenantId, tenantId),
    eq(schema.contractAbis.chainId, chainId),
    eq(schema.contractAbis.address, key(address)),
    eq(schema.contractAbis.source, "manual"),
  );
  const [existing] = await client
    .select({ tenantId: schema.contractAbis.tenantId })
    .from(schema.contractAbis)
    .where(predicate)
    .limit(1);
  if (!existing) return false;

  const database = await getDatabase();
  await database
    .prepare(
      `delete from contract_abis_v2
        where tenant_id = ? and chain_id = ? and address = ? and source = 'manual'`,
    )
    .bind(tenantId, chainId, key(address))
    .run();

  const [remaining] = await client
    .select({ tenantId: schema.contractAbis.tenantId })
    .from(schema.contractAbis)
    .where(predicate)
    .limit(1);
  if (remaining) throw new Error("Manual ABI deletion did not take effect.");
  return true;
}
