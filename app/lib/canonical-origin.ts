/**
 * Browser storage is per origin, and `localhost` and `127.0.0.1` are different
 * origins even on the same server. Local work (contract list, drafts, saved
 * keys) would split between them, so a local run always uses 127.0.0.1.
 *
 * Returns the URL to move to, or null when the page is already canonical.
 */
export function canonicalLocalUrl(href: string): string | null {
  const url = new URL(href);
  if (url.hostname !== "localhost") return null;
  url.hostname = "127.0.0.1";
  return url.toString();
}
