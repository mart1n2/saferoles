/**
 * Regenerates the checked-in D1 migrations from `db/ddl.ts`.
 *
 * The TypeScript DDL is the source of truth; the .sql files exist for the
 * hosted migration pipeline. `tests/schema.test.ts` fails if they drift.
 */
import { writeFileSync } from "node:fs";
import {
  AUTHENTICATED_SCHEMA_SQL,
  AUTHENTICATED_SQL_FILE_HEADER,
  AUTHENTICATED_SQL_FILE_PATH,
  SCHEMA_SQL,
  SQL_FILE_HEADER,
  SQL_FILE_PATH,
} from "../db/ddl";

writeFileSync(SQL_FILE_PATH, SQL_FILE_HEADER + SCHEMA_SQL);
process.stdout.write(`wrote ${SQL_FILE_PATH}\n`);

writeFileSync(
  AUTHENTICATED_SQL_FILE_PATH,
  AUTHENTICATED_SQL_FILE_HEADER + AUTHENTICATED_SCHEMA_SQL,
);
process.stdout.write(`wrote ${AUTHENTICATED_SQL_FILE_PATH}\n`);
