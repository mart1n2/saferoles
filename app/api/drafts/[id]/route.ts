import { getPersistenceActor } from "../../../chatgpt-auth";
import { DatabaseUnavailableError } from "../../../lib/db-binding";
import {
  DraftVersionConflictError,
  deleteDraft,
  getDraft,
  saveDraft,
} from "../../../lib/drafts";
import {
  InputError,
  MAX_DRAFT_BODY_BYTES,
  jsonResponse,
  parseDraftScope,
  parseDraftUpdatePayload,
  parseJsonRequest,
} from "../../../lib/serialize";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const actor = await getPersistenceActor();
  if (!actor) return unauthorized();

  const { id } = await context.params;
  try {
    const scope = parseDraftScope(new URL(request.url));
    const draft = await getDraft(actor, id, scope);
    if (!draft) return jsonResponse({ error: "No such draft." }, { status: 404 });
    return jsonResponse({ draft });
  } catch (error) {
    return handle(error);
  }
}

export async function PUT(request: Request, context: Context): Promise<Response> {
  const actor = await getPersistenceActor();
  if (!actor) return unauthorized();

  const { id } = await context.params;
  try {
    const body = parseDraftUpdatePayload(
      await parseJsonRequest(request, MAX_DRAFT_BODY_BYTES),
    );
    const draft = await saveDraft(actor, {
      draftId: id,
      ...body,
    });
    if (!draft) return jsonResponse({ error: "No such draft." }, { status: 404 });
    return jsonResponse({ draft });
  } catch (error) {
    return handle(error);
  }
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  const actor = await getPersistenceActor();
  if (!actor) return unauthorized();

  const { id } = await context.params;
  try {
    const scope = parseDraftScope(new URL(request.url), { requireVersion: true });
    const deleted = await deleteDraft(
      actor,
      id,
      scope,
      scope.version as number,
    );
    if (!deleted) return jsonResponse({ error: "No such draft." }, { status: 404 });
    return jsonResponse({ deleted: true });
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
  if (error instanceof DraftVersionConflictError) {
    return jsonResponse(
      { error: error.message, currentVersion: error.currentVersion },
      { status: 409 },
    );
  }
  if (error instanceof DatabaseUnavailableError) {
    return jsonResponse({ error: error.message }, { status: 503 });
  }
  return jsonResponse({ error: "Draft storage failed." }, { status: 500 });
}
