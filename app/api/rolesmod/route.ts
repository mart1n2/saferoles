/**
 * Reads the live policy of one Roles modifier.
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
    const mod = await fetchRolesMod({
      chainId,
      address: getAddress(address).toLowerCase() as `0x${string}`,
    });
    if (!mod) {
      return jsonResponse(
        {
          error: `No Roles modifier is indexed at ${address} on ${chainName(chainId)}.`,
        },
        { status: 404 },
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
