/**
 * Readable function names for many contracts at once.
 *
 * The permission list shows one row per function, and a types-only signature
 * there leaves a reviewer guessing which argument is the recipient. Resolving
 * each target's ABI one request at a time would be far too slow for a role with
 * dozens of targets, so this returns just what the list needs: a selector →
 * readable-signature map per address.
 */
import { getAddress, isAddress } from "ethers";
import { resolveAbi } from "../../lib/abi-source";
import { readStoredAbi, writeStoredAbi } from "../../lib/abi-store";
import { jsonResponse } from "../../lib/serialize";

/** Bounded so one request cannot fan out indefinitely against the ABI sources. */
const MAX_ADDRESSES = 60;
/** Kept low to stay well within the ABI sources' tolerance. */
const CONCURRENCY = 6;

export type FunctionNames = Record<string, Record<string, string>>;

async function inBatches<T>(
  items: readonly T[],
  size: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  for (let index = 0; index < items.length; index += size) {
    await Promise.all(items.slice(index, index + size).map(worker));
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: { chainId?: number; addresses?: string[] };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Expected a JSON body." }, { status: 400 });
  }

  const chainId = body.chainId;
  if (!Number.isInteger(chainId)) {
    return jsonResponse({ error: "Provide a chainId." }, { status: 400 });
  }

  const unique = [
    ...new Set(
      (body.addresses ?? [])
        .filter((address) => isAddress(address))
        .map((address) => getAddress(address)),
    ),
  ];
  if (unique.length === 0) {
    return jsonResponse({ functions: {}, truncated: false });
  }

  const requested = unique.slice(0, MAX_ADDRESSES);
  const functions: FunctionNames = {};

  await inBatches(requested, CONCURRENCY, async (address) => {
    try {
      // A stored copy is the common case after the first visit.
      let resolved = await readStoredAbi(chainId as number, address);
      if (!resolved) {
        resolved = await resolveAbi(
          chainId as number,
          address,
          AbortSignal.timeout(10_000),
        );
        if (resolved) await writeStoredAbi(resolved);
      }
      if (!resolved) return;

      const entry: Record<string, string> = {};
      for (const fn of resolved.functions) {
        entry[fn.selector.toLowerCase()] = fn.readable;
      }
      functions[address.toLowerCase()] = entry;
    } catch {
      // An unresolvable target simply keeps its canonical signature.
    }
  });

  return jsonResponse({
    functions,
    // Reported rather than hidden: a silently truncated list would look complete.
    truncated: unique.length > requested.length,
    requested: requested.length,
  });
}
