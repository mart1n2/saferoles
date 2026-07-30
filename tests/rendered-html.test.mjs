import assert from "node:assert/strict";
import test from "node:test";

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

async function render(path = "/", env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }) {
  const worker = await loadWorker();
  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { accept: "text/html" },
    }),
    env,
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the SafeRoles console shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  const text = html.replaceAll(/<!--.*?-->/g, "");
  assert.match(html, /<title>SafeRoles — RBAC Policy Console<\/title>/i);
  assert.match(text, /SafeRoles/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("no sample policy is baked into the served page", async () => {
  const response = await render();
  const html = await response.text();

  // The console reads live state from the modifier. Any of these appearing in
  // the served markup would mean seeded demo policy had returned.
  for (const ghost of [
    "Treasury Operator",
    "Revenue Sweeper",
    "Emergency Guardian",
    "daily_usdc",
    "0x182B",
    "31,240",
    "Demo baseline",
  ]) {
    assert.ok(
      !html.includes(ghost),
      `served page still contains sample data: ${ghost}`,
    );
  }
});

test("renders when the runtime supplies no bindings at all", async () => {
  // `vinext start` runs the worker under a plain Node server with no `env`.
  // Reaching into it unguarded failed every request, not just the features that
  // needed a binding.
  for (const env of [undefined, {}]) {
    const response = await render("/", env);
    assert.equal(
      response.status,
      200,
      `expected a page with env=${JSON.stringify(env)}`,
    );
    assert.match(await response.text(), /SafeRoles/);
  }
});

test("declares the icon set, including raster fallbacks", async () => {
  const response = await render();
  const html = await response.text();

  assert.match(html, /rel="icon"[^>]*\/favicon\.svg/);
  assert.match(html, /\/favicon-32\.png/);
  assert.match(html, /rel="apple-touch-icon"[^>]*\/apple-touch-icon\.png/);
  // The replaced template icon must be gone.
  assert.doesNotMatch(html, /68C4FF|0C79D8/i);
});

test("the Safe App manifest is served with CORS headers", async () => {
  // The Safe UI fetches this cross-origin before it will load the app. As a
  // static file in public/ it was served ahead of worker code and carried no
  // CORS headers, so the Safe could not read it.
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("http://localhost/manifest.json"),
    {},
    { waitUntil() {}, passThroughOnException() {} },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);

  const manifest = JSON.parse(await response.text());
  assert.equal(manifest.name, "SafeRoles");
  assert.ok(manifest.iconPath, "Safe needs an icon path");
});

test("truncated placeholder addresses never reach the client", async () => {
  const response = await render();
  const html = await response.text();
  // e.g. "0x71C7…4D8F" — display-shortened text that is not a usable address.
  assert.doesNotMatch(
    html,
    /0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}/,
    "found a hardcoded shortened address in the served markup",
  );
});
