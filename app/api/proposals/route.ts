import { getPersistenceActor } from "../../chatgpt-auth";
import { DatabaseUnavailableError } from "../../lib/db-binding";
import {
  ProposalConflictError,
  listProposals,
  recordProposal,
} from "../../lib/drafts";
import {
  InputError,
  MAX_PROPOSAL_BODY_BYTES,
  jsonResponse,
  parseDraftScope,
  parseJsonRequest,
  parseProposalPayload,
} from "../../lib/serialize";

export async function GET(request: Request): Promise<Response> {
  const actor = await getPersistenceActor();
  if (!actor) return unauthorized();

  try {
    const scope = parseDraftScope(new URL(request.url));
    return jsonResponse(
      await listProposals(actor, scope.chainId, scope.rolesMod),
    );
  } catch (error) {
    return handle(error);
  }
}

/** Records a typed submission reference after the wallet or Safe accepted it. */
export async function POST(request: Request): Promise<Response> {
  const actor = await getPersistenceActor();
  if (!actor) return unauthorized();

  try {
    const body = parseProposalPayload(
      await parseJsonRequest(request, MAX_PROPOSAL_BODY_BYTES),
    );
    const result = await recordProposal(actor, body);
    return jsonResponse(
      { recorded: true, created: result.created },
      { status: result.created ? 201 : 200 },
    );
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
  if (error instanceof ProposalConflictError) {
    return jsonResponse({ error: error.message }, { status: 409 });
  }
  if (error instanceof DatabaseUnavailableError) {
    return jsonResponse({ error: error.message }, { status: 503 });
  }
  return jsonResponse({ error: "Proposal storage failed." }, { status: 500 });
}
