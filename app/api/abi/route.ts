/**
 * Contract ABI lookup and tenant-owned manual entry.
 *
 * Live verified-source lookup stays public. Manual reads/writes are scoped to
 * the authenticated Sites user and never share a row with the public cache.
 */
import { getPersistenceActor } from "../../chatgpt-auth";
import {
  parseManualAbi,
  resolveAbi,
  type ResolvedAbi,
} from "../../lib/abi-source";
import {
  forgetStoredAbi,
  readStoredAbi,
  writeStoredAbi,
} from "../../lib/abi-store";
import { DatabaseUnavailableError } from "../../lib/db-binding";
import { chainName, isSupportedChain } from "../../lib/chains";
import {
  InputError,
  MAX_ABI_BODY_BYTES,
  jsonResponse,
  parseAbiScope,
  parseJsonRequest,
  parseManualAbiPayload,
} from "../../lib/serialize";

const MAX_ABI_ENTRIES = 5_000;
const MAX_ABI_FUNCTIONS = 2_000;

export async function GET(request: Request): Promise<Response> {
  let scope: { chainId: number; address: string };
  try {
    scope = parseAbiScope(new URL(request.url));
  } catch (error) {
    return handle(error);
  }

  const actor = await getPersistenceActor();
  const { chainId, address } = scope;
  let cacheWarning: string | undefined;
  try {
    const stored = await readStoredAbi(chainId, address, actor?.tenantId);
    if (stored) return jsonResponse({ abi: stored, cached: true });
  } catch {
    // Cache corruption/outage must not prevent a public verified-source lookup.
    cacheWarning = "The stored ABI cache could not be read; live sources were used.";
  }

  let resolved: ResolvedAbi | null = null;
  try {
    resolved = await resolveAbi(chainId, address, AbortSignal.timeout(12_000));
  } catch {
    resolved = null;
  }

  if (!resolved) {
    return jsonResponse(
      {
        abi: null,
        reason: isSupportedChain(chainId)
          ? `No verified ABI was found for ${address} on ${chainName(chainId)}. Paste the ABI to continue.`
          : `Chain ${chainId} has no ABI source configured. Paste the ABI to continue.`,
        ...(cacheWarning ? { cacheWarning } : {}),
      },
      { status: 200 },
    );
  }

  // Close the common read→resolve race: a manual entry saved while the live
  // lookup was in flight is authoritative for this tenant.
  if (actor) {
    try {
      const latest = await readStoredAbi(chainId, address, actor.tenantId);
      if (latest?.source === "manual") {
        return jsonResponse({ abi: latest, cached: true });
      }
    } catch {
      cacheWarning =
        "The manual ABI store could not be rechecked; the live verified ABI is shown.";
    }
  }

  let cacheStored = false;
  try {
    await writeStoredAbi(resolved);
    cacheStored = true;
  } catch {
    cacheWarning = "The live ABI was resolved but could not be cached.";
  }
  return jsonResponse({
    abi: resolved,
    cached: false,
    cacheStored,
    ...(cacheWarning ? { cacheWarning } : {}),
  });
}

export async function POST(request: Request): Promise<Response> {
  const actor = await getPersistenceActor();
  if (!actor) return unauthorized();

  try {
    const body = parseManualAbiPayload(
      await parseJsonRequest(request, MAX_ABI_BODY_BYTES),
    );
    let parsed: ReturnType<typeof parseManualAbi>;
    try {
      parsed = parseManualAbi(body.abi);
    } catch (error) {
      throw new InputError(
        error instanceof Error ? error.message : "That ABI could not be read.",
      );
    }
    if (
      parsed.abi.length > MAX_ABI_ENTRIES ||
      parsed.functions.length > MAX_ABI_FUNCTIONS
    ) {
      throw new InputError(
        `ABI exceeds the ${MAX_ABI_ENTRIES}-entry or ${MAX_ABI_FUNCTIONS}-function limit.`,
        413,
      );
    }

    const resolved: ResolvedAbi = {
      chainId: body.chainId,
      address: body.address,
      source: "manual",
      name: body.name?.trim() || null,
      implementation: null,
      proxyType: null,
      functions: parsed.functions,
      abi: parsed.abi,
    };
    await writeStoredAbi(resolved, actor.tenantId);
    return jsonResponse({ abi: resolved }, { status: 201 });
  } catch (error) {
    return handle(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const actor = await getPersistenceActor();
  if (!actor) return unauthorized();

  try {
    const scope = parseAbiScope(new URL(request.url));
    const forgotten = await forgetStoredAbi(
      scope.chainId,
      scope.address,
      actor.tenantId,
    );
    return jsonResponse({ forgotten });
  } catch (error) {
    return handle(error);
  }
}

function unauthorized(): Response {
  return jsonResponse({ error: "Authentication is required." }, { status: 401 });
}

function handle(error: unknown): Response {
  if (error instanceof InputError) {
    return jsonResponse({ error: error.message }, { status: error.status });
  }
  if (error instanceof DatabaseUnavailableError) {
    return jsonResponse({ error: error.message }, { status: 503 });
  }
  return jsonResponse({ error: "ABI storage failed." }, { status: 500 });
}
