/**
 * Drizzle client over the D1 binding, with lazy schema bootstrap.
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { requireDatabase, type D1Database } from "../app/lib/db-binding";
import { SCHEMA_STATEMENTS } from "./ddl";
import * as schema from "./schema";

type Client = DrizzleD1Database<typeof schema>;

const bootstrapped = new WeakSet<object>();

/**
 * Applies the schema once per binding.
 *
 * Every statement is `if not exists`, so this is safe to run against a database
 * the hosted migration pipeline has already migrated.
 */
async function ensureSchema(database: D1Database): Promise<void> {
  if (bootstrapped.has(database)) return;
  for (const statement of SCHEMA_STATEMENTS) {
    await database.prepare(statement).run();
  }
  bootstrapped.add(database);
}

export async function getClient(): Promise<Client> {
  const database = requireDatabase();
  await ensureSchema(database);
  // The drizzle d1 driver expects the full D1Database surface; the local type
  // narrows it to what this app uses.
  return drizzle(database as never, { schema });
}

export { schema };
