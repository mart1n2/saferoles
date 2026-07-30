import { jsonResponse } from "../../lib/serialize";
import { getDatabaseBinding } from "../../lib/db-binding";

/** Reports whether the route layer and the D1 binding are both reachable. */
export async function GET(): Promise<Response> {
  const binding = getDatabaseBinding();
  let database: string;
  if (!binding) {
    database = "unbound";
  } else {
    try {
      await binding.prepare("select 1").first();
      database = "ok";
    } catch (error) {
      database = `error: ${error instanceof Error ? error.message : "unknown"}`;
    }
  }
  return jsonResponse({ routes: "ok", database });
}
