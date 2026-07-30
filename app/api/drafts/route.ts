import { isAddress } from "ethers";
import { DatabaseUnavailableError } from "../../lib/db-binding";
import { createDraft, listDrafts } from "../../lib/drafts";
import { jsonResponse } from "../../lib/serialize";
import type { DraftPolicy } from "../../lib/policy";

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
    return jsonResponse({ drafts: await listDrafts(chainId, rolesMod) });
  } catch (error) {
    return handle(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: {
    name?: string;
    chainId?: number;
    rolesMod?: string;
    safeAddress?: string;
    policy?: DraftPolicy;
    baseStateHash?: string | null;
    createdBy?: string | null;
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
    !body.policy
  ) {
    return jsonResponse(
      { error: "A draft needs a chainId, Roles modifier, Safe address and policy." },
      { status: 400 },
    );
  }

  try {
    const draft = await createDraft({
      name: body.name ?? "",
      chainId: body.chainId as number,
      rolesMod: body.rolesMod as string,
      safeAddress: body.safeAddress as string,
      policy: body.policy,
      baseStateHash: body.baseStateHash ?? null,
      createdBy: body.createdBy ?? null,
    });
    return jsonResponse({ draft }, { status: 201 });
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
      error: `Draft storage failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    },
    { status: 500 },
  );
}
