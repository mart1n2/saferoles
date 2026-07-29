import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the SafeRoles RBAC workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  const text = html.replaceAll(/<!--.*?-->/g, "");
  assert.match(html, /<title>SafeRoles — RBAC Policy Console<\/title>/i);
  assert.match(text, /Treasury Operator/);
  assert.match(text, /Permissions/);
  assert.match(text, /Connect wallet/);
  assert.match(text, /Review 2 changes/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});
