import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { SCHEMA_SQL, SQL_FILE_HEADER, SQL_FILE_PATH } from "../db/ddl";

test("the generated migration matches the TypeScript schema", () => {
  const onDisk = readFileSync(SQL_FILE_PATH, "utf8");
  assert.equal(
    onDisk,
    SQL_FILE_HEADER + SCHEMA_SQL,
    `${SQL_FILE_PATH} is stale. Regenerate it with: npm run db:generate`,
  );
});

test("every schema statement is idempotent", () => {
  // The same DDL runs through the hosted migration pipeline and through the
  // lazy bootstrap, so re-running it must never fail.
  for (const statement of SCHEMA_SQL.split(";\n\n")) {
    const trimmed = statement.trim();
    if (!trimmed) continue;
    assert.match(
      trimmed,
      /^create (table|index) if not exists/,
      `not idempotent: ${trimmed.slice(0, 60)}`,
    );
  }
});
