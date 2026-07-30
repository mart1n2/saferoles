/**
 * Candidate signatures for 4-byte selectors.
 *
 * Used to make an imported policy readable when its target contract is not
 * verified. Results are suggestions only — a selector is a truncated hash, so
 * collisions exist and the client verifies before adopting one.
 */
import { lookupSelectors } from "../../lib/abi-source";
import { jsonResponse } from "../../lib/serialize";

const MAX_SELECTORS = 200;

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const list = (url.searchParams.get("list") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (list.length === 0) {
    return jsonResponse({ error: "Provide a comma-separated selector list." }, { status: 400 });
  }
  if (list.length > MAX_SELECTORS) {
    return jsonResponse(
      { error: `Too many selectors in one request (limit ${MAX_SELECTORS}).` },
      { status: 400 },
    );
  }

  try {
    const signatures = await lookupSelectors(list, AbortSignal.timeout(12_000));
    return jsonResponse({ signatures });
  } catch (error) {
    return jsonResponse(
      {
        error: `Selector lookup failed: ${
          error instanceof Error ? error.message : "the directory is unavailable"
        }`,
      },
      { status: 502 },
    );
  }
}
