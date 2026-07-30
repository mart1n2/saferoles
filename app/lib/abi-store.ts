/**
 * Caching and manual storage for contract ABIs.
 *
 * A manual ABI is authoritative: someone entered it because no source had the
 * contract verified, so a later automatic lookup must never overwrite it.
 */
import { and, eq } from "drizzle-orm";
import { getClient, schema } from "../../db/client";
import { getDatabaseBinding } from "./db-binding";
import { describeFunctions, type AbiSource, type ResolvedAbi } from "./abi-source";

function key(address: string): string {
  return address.trim().toLowerCase();
}

export async function readStoredAbi(
  chainId: number,
  address: string,
): Promise<ResolvedAbi | null> {
  if (!getDatabaseBinding()) return null;
  try {
    const client = await getClient();
    const [row] = await client
      .select()
      .from(schema.contractAbis)
      .where(
        and(
          eq(schema.contractAbis.chainId, chainId),
          eq(schema.contractAbis.address, key(address)),
        ),
      )
      .limit(1);
    if (!row) return null;

    const abi = JSON.parse(row.abi) as unknown[];
    return {
      chainId: row.chainId,
      address,
      source: row.source as AbiSource,
      name: row.name,
      implementation: row.implementation,
      proxyType: row.proxyType,
      functions: describeFunctions(abi),
      abi,
    };
  } catch {
    // Cache problems must never block a live lookup.
    return null;
  }
}

export async function writeStoredAbi(resolved: ResolvedAbi): Promise<void> {
  if (!getDatabaseBinding()) return;
  try {
    const client = await getClient();
    const row = {
      chainId: resolved.chainId,
      address: key(resolved.address),
      abi: JSON.stringify(resolved.abi),
      source: resolved.source,
      name: resolved.name,
      implementation: resolved.implementation,
      proxyType: resolved.proxyType,
      updatedAt: Date.now(),
    };

    const existing = await readStoredAbi(resolved.chainId, resolved.address);
    if (existing?.source === "manual" && resolved.source !== "manual") return;

    await client
      .insert(schema.contractAbis)
      .values(row)
      .onConflictDoUpdate({
        target: [schema.contractAbis.chainId, schema.contractAbis.address],
        set: {
          abi: row.abi,
          source: row.source,
          name: row.name,
          implementation: row.implementation,
          proxyType: row.proxyType,
          updatedAt: row.updatedAt,
        },
      });
  } catch {
    // Storage is an optimisation, not a requirement.
  }
}

export async function forgetStoredAbi(chainId: number, address: string): Promise<void> {
  if (!getDatabaseBinding()) return;
  try {
    const client = await getClient();
    await client
      .delete(schema.contractAbis)
      .where(
        and(
          eq(schema.contractAbis.chainId, chainId),
          eq(schema.contractAbis.address, key(address)),
        ),
      );
  } catch {
    // Nothing to do.
  }
}
