/**
 * Reads the indexer's policy snapshot for one Roles modifier.
 *
 * Proxied through the Worker rather than called from the browser so the app
 * works inside the Safe App iframe without depending on the indexer's CORS
 * policy.
 */
import { isAddress, getAddress } from "ethers";
import { fetchRolesMod } from "zodiac-roles-sdk";
import { isSupportedChain, chainName } from "../../lib/chains";
import { jsonResponse } from "../../lib/serialize";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const address = url.searchParams.get("address") ?? "";
  const chainId = Number(url.searchParams.get("chainId"));
  const fresh = url.searchParams.has("fresh");

  if (!isAddress(address)) {
    return jsonResponse(
      { error: "Provide a complete Roles modifier address." },
      { status: 400 },
    );
  }
  if (!Number.isInteger(chainId) || !isSupportedChain(chainId)) {
    return jsonResponse(
      {
        error: `The Roles indexer does not cover ${chainId ? chainName(chainId) : "that chain"}.`,
      },
      { status: 400 },
    );
  }

  try {
    const requestedAddress = getAddress(address).toLowerCase() as `0x${string}`;
    const mod = await fetchRolesMod(
      {
        chainId,
        address: requestedAddress,
      },
      fresh
        ? {
            cache: "no-store",
            headers: {
              "cache-control": "no-cache, no-store, max-age=0",
              pragma: "no-cache",
            },
          }
        : undefined,
    );
    if (!mod) {
      return jsonResponse(
        {
          error: `No Roles modifier is indexed at ${address} on ${chainName(chainId)}.`,
        },
        { status: 404 },
      );
    }
    if (
      !isAddress(mod.address) ||
      mod.address.toLowerCase() !== requestedAddress
    ) {
      return jsonResponse(
        {
          error:
            "The Roles indexer returned a modifier that does not match the requested address.",
        },
        { status: 502 },
      );
    }
    return jsonResponse({ mod });
  } catch (error) {
    return jsonResponse(
      {
        error: `Could not read the policy: ${
          error instanceof Error ? error.message : "the indexer is unavailable"
        }`,
      },
      { status: 502 },
    );
  }
}
