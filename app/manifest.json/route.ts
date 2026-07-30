/**
 * The Safe App manifest.
 *
 * Served by a route handler rather than as a static file in `public/` because the
 * Safe UI fetches it cross-origin before it will load the app, and it therefore
 * needs CORS headers. Static assets are served ahead of worker code, so a file in
 * `public/` cannot carry them.
 */

const manifest = {
  name: "SafeRoles",
  description: "RBAC policy control for Zodiac Roles, with Safe-native approvals.",
  iconPath: "favicon-192.png",
  safe_apps_permissions: [],
};

const headers = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "cache-control": "public, max-age=300",
};

export function GET(): Response {
  return new Response(JSON.stringify(manifest, null, 2), { headers });
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers });
}
