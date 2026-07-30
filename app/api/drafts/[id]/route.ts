import { DatabaseUnavailableError } from "../../../lib/db-binding";
import { deleteDraft, getDraft, saveDraft } from "../../../lib/drafts";
import { jsonResponse } from "../../../lib/serialize";
import type { DraftPolicy } from "../../../lib/policy";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  try {
    const draft = await getDraft(id);
    if (!draft) return jsonResponse({ error: "No such draft." }, { status: 404 });
    return jsonResponse({ draft });
  } catch (error) {
    return handle(error);
  }
}

export async function PUT(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  let body: {
    policy?: DraftPolicy;
    name?: string;
    note?: string | null;
    author?: string | null;
    baseStateHash?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Expected a JSON body." }, { status: 400 });
  }
  if (!body.policy) {
    return jsonResponse({ error: "A policy is required." }, { status: 400 });
  }

  try {
    const draft = await saveDraft({
      draftId: id,
      policy: body.policy,
      name: body.name,
      note: body.note ?? null,
      author: body.author ?? null,
      baseStateHash: body.baseStateHash ?? null,
    });
    if (!draft) return jsonResponse({ error: "No such draft." }, { status: 404 });
    return jsonResponse({ draft });
  } catch (error) {
    return handle(error);
  }
}

export async function DELETE(_request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  try {
    await deleteDraft(id);
    return jsonResponse({ deleted: true });
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
