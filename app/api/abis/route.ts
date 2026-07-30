/**
 * Readable function names for many contracts at once.
 *
 * Verified-source lookup is public. If an authenticated user is present, their
 * tenant-owned manual ABI is preferred without exposing it to another tenant.
 */
import { getAddress } from "ethers";
import { getPersistenceActor } from "../../chatgpt-auth";
import { resolveAbi } from "../../lib/abi-source";
import { readStoredAbi, writeStoredAbi } from "../../lib/abi-store";
import {
  InputError,
  MAX_ABI_BODY_BYTES,
  jsonResponse,
  parseAbiBatchPayload,
  parseJsonRequest,
} from "../../lib/serialize";

const MAX_ADDRESSES = 60;
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
  let body: ReturnType<typeof parseAbiBatchPayload>;
  try {
    body = parseAbiBatchPayload(
      await parseJsonRequest(request, MAX_ABI_BODY_BYTES),
    );
  } catch (error) {
    if (error instanceof InputError) {
      return jsonResponse({ error: error.message }, { status: error.status });
    }
    return jsonResponse({ error: "ABI lookup request failed." }, { status: 400 });
  }

  const actor = await getPersistenceActor();
  const unique = [
    ...new Set(body.addresses.map((address) => getAddress(address))),
  ];
  if (unique.length === 0) {
    return jsonResponse({ functions: {}, truncated: false, requested: 0 });
  }

  const requested = unique.slice(0, MAX_ADDRESSES);
  const functions: FunctionNames = {};
  let cacheWarnings = 0;

  await inBatches(requested, CONCURRENCY, async (address) => {
    try {
      let resolved = null;
      try {
        resolved = await readStoredAbi(
          body.chainId,
          address,
          actor?.tenantId,
        );
      } catch {
        cacheWarnings += 1;
      }
      if (!resolved) {
        resolved = await resolveAbi(
          body.chainId,
          address,
          AbortSignal.timeout(10_000),
        );
        if (resolved) {
          // Prefer a manual ABI created while the live lookup was in flight.
          if (actor) {
            try {
              const latest = await readStoredAbi(
                body.chainId,
                address,
                actor.tenantId,
              );
              if (latest?.source === "manual") resolved = latest;
            } catch {
              cacheWarnings += 1;
            }
          }
          if (resolved.source !== "manual") {
            try {
              await writeStoredAbi(resolved);
            } catch {
              cacheWarnings += 1;
            }
          }
        }
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
    truncated: unique.length > requested.length,
    requested: requested.length,
    ...(cacheWarnings > 0 ? { cacheWarnings } : {}),
  });
}
