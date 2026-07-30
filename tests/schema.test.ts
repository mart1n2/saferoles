import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  AUTHENTICATED_SCHEMA_SQL,
  AUTHENTICATED_SQL_FILE_HEADER,
  AUTHENTICATED_SQL_FILE_PATH,
  SCHEMA_SQL,
  SQL_FILE_HEADER,
  SQL_FILE_PATH,
} from "../db/ddl";

const migrations = [
  {
    path: SQL_FILE_PATH,
    sql: SCHEMA_SQL,
    header: SQL_FILE_HEADER,
  },
  {
    path: AUTHENTICATED_SQL_FILE_PATH,
    sql: AUTHENTICATED_SCHEMA_SQL,
    header: AUTHENTICATED_SQL_FILE_HEADER,
  },
] as const;

test("the generated migrations match the TypeScript schema", () => {
  for (const migration of migrations) {
    const onDisk = readFileSync(migration.path, "utf8");
    assert.equal(
      onDisk,
      migration.header + migration.sql,
      `${migration.path} is stale. Regenerate it with: npm run db:generate`,
    );
  }
});

test("every schema statement is idempotent", () => {
  // Hosted migrations can be retried, and the current schema also runs through
  // the local lazy bootstrap, so replaying either file must never fail.
  for (const migration of migrations) {
    for (const statement of migration.sql.split(";\n\n")) {
      const trimmed = statement.trim();
      if (!trimmed) continue;
      assert.match(
        trimmed,
        /^create (?:table|(?:unique )?index) if not exists/,
        `${migration.path} is not idempotent: ${trimmed.slice(0, 60)}`,
      );
    }
  }
});
