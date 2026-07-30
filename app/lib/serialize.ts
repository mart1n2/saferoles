/**
 * BigInt-safe JSON transport.
 *
 * Allowance amounts and periods are `bigint`, which `JSON.stringify` refuses to
 * serialize. Values are tagged on the way out and revived on the way in so a
 * budget never silently arrives as a lossy `number`.
 */

const TAG = "$bigint";

type Tagged = { [TAG]: string };

function isTagged(value: unknown): value is Tagged {
  return (
    typeof value === "object" &&
    value !== null &&
    TAG in value &&
    typeof (value as Tagged)[TAG] === "string"
  );
}

export function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry) =>
    typeof entry === "bigint" ? { [TAG]: entry.toString() } : entry,
  );
}

export function parse<T>(text: string): T {
  return JSON.parse(text, (_key, entry) =>
    isTagged(entry) ? BigInt(entry[TAG]) : entry,
  ) as T;
}

/** Revives tagged values in an already-parsed structure. */
export function revive<T>(value: unknown): T {
  if (Array.isArray(value)) return value.map((entry) => revive(entry)) as T;
  if (isTagged(value)) return BigInt(value[TAG]) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, revive(entry)]),
    ) as T;
  }
  return value as T;
}

export function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(stringify(value), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...init?.headers,
    },
  });
}
