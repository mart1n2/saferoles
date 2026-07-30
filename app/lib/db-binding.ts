/**
 * Access to the D1 binding declared in `.openai/hosting.json`.
 *
 * The Worker entry point is the only thing that legitimately holds `env`, so it
 * hands the binding over per request rather than this module guessing at
 * runtime globals.
 *
 * Resolution is tolerant on purpose: the console can inspect indexed policy
 * without a database, so a missing binding degrades draft persistence instead
 * of breaking the app.
 */

/** The subset of D1 this app uses. */
export type D1Result<T> = { results: T[]; success: boolean };

export type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(column?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<unknown>;
};

export type D1Database = {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
};

export const DATABASE_BINDING = "DB";

let binding: D1Database | null = null;

/** Called by the Worker entry point on every request. */
export function setDatabaseBinding(next: D1Database | null): void {
  binding = next;
}

export function getDatabaseBinding(): D1Database | null {
  return binding;
}

export class DatabaseUnavailableError extends Error {
  constructor() {
    super(
      "No database is bound, so drafts cannot be saved. Indexed policy inspection and proposals still work.",
    );
    this.name = "DatabaseUnavailableError";
  }
}

export function requireDatabase(): D1Database {
  const database = getDatabaseBinding();
  if (!database) throw new DatabaseUnavailableError();
  return database;
}
