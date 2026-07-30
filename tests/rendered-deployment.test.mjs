import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("deployment-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

const context = {
  waitUntil() {},
  passThroughOnException() {},
};

test("the deployment build packages the exact Sites and D1 metadata", async () => {
  const [
    sourceHosting,
    builtHosting,
    sourceInitialMigration,
    builtInitialMigration,
    sourceAuthenticatedMigration,
    builtAuthenticatedMigration,
  ] = await Promise.all([
    readFile(new URL(".openai/hosting.json", projectRoot), "utf8"),
    readFile(new URL("dist/.openai/hosting.json", projectRoot), "utf8"),
    readFile(new URL("drizzle/0000_init.sql", projectRoot), "utf8"),
    readFile(new URL("dist/.openai/drizzle/0000_init.sql", projectRoot), "utf8"),
    readFile(
      new URL("drizzle/0001_authenticated_persistence.sql", projectRoot),
      "utf8",
    ),
    readFile(
      new URL(
        "dist/.openai/drizzle/0001_authenticated_persistence.sql",
        projectRoot,
      ),
      "utf8",
    ),
  ]);

  assert.equal(
    builtHosting,
    sourceHosting,
    "the deployed binding contract must match .openai/hosting.json",
  );
  assert.equal(
    builtInitialMigration,
    sourceInitialMigration,
    "the deployment archive must contain the reviewed initial D1 migration",
  );
  assert.equal(
    builtAuthenticatedMigration,
    sourceAuthenticatedMigration,
    "the deployment archive must contain the reviewed authenticated D1 migration",
  );
});

test("the built health route reports an absent optional D1 binding", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("http://localhost/api/health"),
    {},
    context,
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/i);
  assert.deepEqual(await response.json(), {
    routes: "ok",
    database: "unbound",
  });
});

test("the Safe manifest answers preflight requests in the built worker", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("http://localhost/manifest.json", { method: "OPTIONS" }),
    {},
    context,
  );

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.match(
    response.headers.get("access-control-allow-methods") ?? "",
    /\bGET\b/,
  );
});

test("every persisted API rejects unauthenticated requests before parsing", async () => {
  const worker = await loadWorker();
  const cases = [
    { method: "GET", path: "/api/drafts" },
    { method: "POST", path: "/api/drafts", body: "{}" },
    { method: "GET", path: "/api/drafts/example" },
    { method: "PUT", path: "/api/drafts/example", body: "{}" },
    { method: "DELETE", path: "/api/drafts/example" },
    { method: "GET", path: "/api/proposals" },
    { method: "POST", path: "/api/proposals", body: "{}" },
    { method: "POST", path: "/api/abi", body: "{}" },
    { method: "DELETE", path: "/api/abi" },
  ];

  for (const entry of cases) {
    const response = await worker.fetch(
      new Request(`http://localhost${entry.path}`, {
        method: entry.method,
        ...(entry.body
          ? {
              body: entry.body,
              headers: { "content-type": "application/json" },
            }
          : {}),
      }),
      {},
      context,
    );

    assert.equal(
      response.status,
      401,
      `${entry.method} ${entry.path} must require authentication`,
    );
    assert.deepEqual(await response.json(), {
      error: "Authentication is required.",
    });
  }
});

test("authenticated persisted APIs reach validation and binding checks", async () => {
  const worker = await loadWorker();
  const authHeaders = {
    "content-type": "application/json",
    "oai-authenticated-user-email": "reviewer@example.test",
  };
  const rolesMod = "0x0000000000000000000000000000000000000001";

  const noDatabase = await worker.fetch(
    new Request(
      `http://localhost/api/drafts?chainId=1&rolesMod=${rolesMod}`,
      { headers: authHeaders },
    ),
    {},
    context,
  );
  assert.equal(noDatabase.status, 503);

  const invalidManualAbi = await worker.fetch(
    new Request("http://localhost/api/abi", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        chainId: 1,
        address: rolesMod,
        abi: "not an ABI",
      }),
    }),
    {},
    context,
  );
  assert.equal(invalidManualAbi.status, 400);
  const invalidBody = await invalidManualAbi.json();
  assert.equal(typeof invalidBody.error, "string");
  assert.notEqual(invalidBody.error, "ABI storage failed.");
});

test("verified ABI reads remain public", async () => {
  const worker = await loadWorker();
  const singleResponse = await worker.fetch(
    new Request("http://localhost/api/abi"),
    {},
    context,
  );

  assert.equal(singleResponse.status, 400);
  const singleBody = await singleResponse.json();
  assert.equal(typeof singleBody.error, "string");
  assert.notEqual(singleBody.error, "Authentication is required.");

  const batchResponse = await worker.fetch(
    new Request("http://localhost/api/abis", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chainId: 1, addresses: [] }),
    }),
    {},
    context,
  );
  assert.equal(batchResponse.status, 200);
  assert.deepEqual(await batchResponse.json(), {
    functions: {},
    truncated: false,
    requested: 0,
  });
});
