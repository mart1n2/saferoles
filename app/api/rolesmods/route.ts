/**
 * Lists the Roles modifiers attached to a Safe.
 *
 * Lets the app discover what it should manage from the connected Safe alone,
 * instead of asking someone to paste a modifier address — the step where
 * pointing at the wrong contract used to be possible.
 */
import { isAddress } from "ethers";
import { discoverRolesMods } from "../../lib/subgraph";
import { jsonResponse } from "../../lib/serialize";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const avatar = url.searchParams.get("avatar") ?? "";
  const chainId = Number(url.searchParams.get("chainId"));

  if (!isAddress(avatar)) {
    return jsonResponse({ error: "Provide a complete Safe address." }, { status: 400 });
  }

  try {
    const all = await discoverRolesMods(avatar);
    // The indexer covers every chain for an avatar. All of them are returned so
    // the app can show a Safe's full footprint; `chainId` only decides ordering,
    // because a Safe can govern a modifier only on its own chain.
    const mods = Number.isInteger(chainId)
      ? [...all].sort((a, b) => {
          const onChain = (mod: { chainId: number }) => (mod.chainId === chainId ? 0 : 1);
          return onChain(a) - onChain(b) || a.chainId - b.chainId;
        })
      : all;
    return jsonResponse({ mods });
  } catch (error) {
    return jsonResponse(
      {
        error: `Could not look up modifiers for this Safe: ${
          error instanceof Error ? error.message : "the indexer is unavailable"
        }`,
      },
      { status: 502 },
    );
  }
}
