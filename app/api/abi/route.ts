/**
 * Contract ABI lookup and manual entry.
 *
 * GET  resolves an ABI for (chainId, address), preferring a stored copy.
 * POST stores a manually supplied ABI for contracts no source has verified.
 * DELETE forgets a stored ABI so the next lookup goes back to the live sources.
 */
import { getAddress, isAddress } from "ethers";
import { parseManualAbi, resolveAbi, type ResolvedAbi } from "../../lib/abi-source";
import { forgetStoredAbi, readStoredAbi, writeStoredAbi } from "../../lib/abi-store";
import { chainName, isSupportedChain } from "../../lib/chains";
import { jsonResponse } from "../../lib/serialize";

function readScope(url: URL): { chainId: number; address: string } | Response {
  const address = url.searchParams.get("address") ?? "";
  const chainId = Number(url.searchParams.get("chainId"));
  if (!isAddress(address)) {
    return jsonResponse({ error: "Provide a complete contract address." }, { status: 400 });
  }
  if (!Number.isInteger(chainId)) {
    return jsonResponse({ error: "Provide a chainId." }, { status: 400 });
  }
  return { chainId, address: getAddress(address) };
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const scope = readScope(url);
  if (scope instanceof Response) return scope;
  const { chainId, address } = scope;

  const stored = await readStoredAbi(chainId, address);
  if (stored) return jsonResponse({ abi: stored, cached: true });

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
      },
      { status: 200 },
    );
  }

  await writeStoredAbi(resolved);
  return jsonResponse({ abi: resolved, cached: false });
}

export async function POST(request: Request): Promise<Response> {
  let body: { chainId?: number; address?: string; abi?: string; name?: string };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (!isAddress(body.address ?? "") || !Number.isInteger(body.chainId)) {
    return jsonResponse(
      { error: "A manual ABI needs a chainId and a complete contract address." },
      { status: 400 },
    );
  }

  let parsed: { abi: unknown[]; functions: ReturnType<typeof parseManualAbi>["functions"] };
  try {
    parsed = parseManualAbi(body.abi ?? "");
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : "That ABI could not be read." },
      { status: 400 },
    );
  }

  const resolved: ResolvedAbi = {
    chainId: body.chainId as number,
    address: getAddress(body.address as string),
    source: "manual",
    name: body.name?.trim() || null,
    implementation: null,
    proxyType: null,
    functions: parsed.functions,
    abi: parsed.abi,
  };

  await writeStoredAbi(resolved);
  return jsonResponse({ abi: resolved }, { status: 201 });
}

export async function DELETE(request: Request): Promise<Response> {
  const scope = readScope(new URL(request.url));
  if (scope instanceof Response) return scope;
  await forgetStoredAbi(scope.chainId, scope.address);
  return jsonResponse({ forgotten: true });
}
