/**
 * Regenerates `drizzle/0000_init.sql` from `db/ddl.ts`.
 *
 * The TypeScript DDL is the source of truth; the .sql file exists for the
 * hosted migration pipeline. `tests/schema.test.ts` fails if they drift.
 */
import { writeFileSync } from "node:fs";
import { SCHEMA_SQL, SQL_FILE_HEADER, SQL_FILE_PATH } from "../db/ddl";

writeFileSync(SQL_FILE_PATH, SQL_FILE_HEADER + SCHEMA_SQL);
process.stdout.write(`wrote ${SQL_FILE_PATH}\n`);
