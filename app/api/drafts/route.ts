import { getPersistenceActor } from "../../chatgpt-auth";
import { DatabaseUnavailableError } from "../../lib/db-binding";
import { createDraft, listDrafts } from "../../lib/drafts";
import {
  InputError,
  MAX_DRAFT_BODY_BYTES,
  jsonResponse,
  parseDraftCreatePayload,
  parseDraftScope,
  parseJsonRequest,
} from "../../lib/serialize";

export async function GET(request: Request): Promise<Response> {
  const actor = await getPersistenceActor();
  if (!actor) return unauthorized();

  try {
    const scope = parseDraftScope(new URL(request.url));
    return jsonResponse({
      drafts: await listDrafts(actor, scope.chainId, scope.rolesMod),
    });
  } catch (error) {
    return handle(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const actor = await getPersistenceActor();
  if (!actor) return unauthorized();

  try {
    const body = parseDraftCreatePayload(
      await parseJsonRequest(request, MAX_DRAFT_BODY_BYTES),
    );
    const draft = await createDraft(actor, body);
    return jsonResponse({ draft }, { status: 201 });
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
  return jsonResponse({ error: "Draft storage failed." }, { status: 500 });
}
