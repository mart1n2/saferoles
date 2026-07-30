import { isAddress } from "ethers";
import type { Call } from "zodiac-roles-sdk";
import { DatabaseUnavailableError } from "../../lib/db-binding";
import { listProposals, recordProposal } from "../../lib/drafts";
import { jsonResponse } from "../../lib/serialize";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const chainId = Number(url.searchParams.get("chainId"));
  const rolesMod = url.searchParams.get("rolesMod") ?? "";

  if (!Number.isInteger(chainId) || !isAddress(rolesMod)) {
    return jsonResponse(
      { error: "Provide a chainId and a complete Roles modifier address." },
      { status: 400 },
    );
  }

  try {
    return jsonResponse({ proposals: await listProposals(chainId, rolesMod) });
  } catch (error) {
    return handle(error);
  }
}

/** Records a proposal that has already been submitted to the Safe. */
export async function POST(request: Request): Promise<Response> {
  let body: {
    draftId?: string | null;
    chainId?: number;
    rolesMod?: string;
    safeAddress?: string;
    safeTxHash?: string;
    risk?: string;
    calls?: Call[];
    proposedBy?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (
    !Number.isInteger(body.chainId) ||
    !isAddress(body.rolesMod ?? "") ||
    !isAddress(body.safeAddress ?? "") ||
    !body.safeTxHash ||
    !Array.isArray(body.calls)
  ) {
    return jsonResponse(
      { error: "A proposal record needs its scope, Safe transaction hash and calls." },
      { status: 400 },
    );
  }

  try {
    await recordProposal({
      draftId: body.draftId ?? null,
      chainId: body.chainId as number,
      rolesMod: body.rolesMod as string,
      safeAddress: body.safeAddress as string,
      safeTxHash: body.safeTxHash,
      risk: body.risk ?? "Low",
      calls: body.calls,
      proposedBy: body.proposedBy ?? null,
    });
    return jsonResponse({ recorded: true }, { status: 201 });
  } catch (error) {
    return handle(error);
  }
}

function handle(error: unknown): Response {
  if (error instanceof DatabaseUnavailableError) {
    return jsonResponse({ error: error.message }, { status: 503 });
  }
  return jsonResponse(
    {
      error: `Proposal storage failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    },
    { status: 500 },
  );
}
