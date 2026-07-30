import assert from "node:assert/strict";
import test from "node:test";
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";
import type { PersistenceActor } from "../app/chatgpt-auth";
import { setDatabaseBinding, type D1Database } from "../app/lib/db-binding";
import {
  DraftVersionConflictError,
  createDraft,
  getDraft,
  listDrafts,
  saveDraft,
} from "../app/lib/drafts";
import type { DraftPolicy } from "../app/lib/policy";

type ResultRow = Record<string, unknown>;

class TestStatement {
  readonly #statement: StatementSync;
  readonly #values: SQLInputValue[];

  constructor(statement: StatementSync, values: SQLInputValue[] = []) {
    this.#statement = statement;
    this.#values = values;
  }

  bind(...values: unknown[]): TestStatement {
    return new TestStatement(
      this.#statement,
      values.map((value) =>
        value instanceof ArrayBuffer ? new Uint8Array(value) : value,
      ) as SQLInputValue[],
    );
  }

  async first<T = unknown>(column?: string): Promise<T | null> {
    const row = this.#statement.get(...this.#values) as ResultRow | undefined;
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }

  async all<T = unknown>(): Promise<{
    results: T[];
    success: boolean;
    meta: { changes: number };
  }> {
    const results = this.#statement.all(...this.#values) as T[];
    return { results, success: true, meta: { changes: 0 } };
  }

  async raw(): Promise<unknown[][]> {
    return (this.#statement.all(...this.#values) as ResultRow[]).map((row) =>
      Object.values(row),
    );
  }

  async run(): Promise<{
    results: unknown[];
    success: boolean;
    meta: { changes: number };
  }> {
    const result = this.#statement.run(...this.#values);
    return {
      results: [],
      success: true,
      meta: { changes: Number(result.changes) },
    };
  }
}

class TestD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  failNextBatchAt: number | null = null;
  #batchTail: Promise<void> = Promise.resolve();

  prepare(query: string): TestStatement {
    return new TestStatement(this.sqlite.prepare(query));
  }

  async batch(statements: TestStatement[]): Promise<unknown[]> {
    const previousBatch = this.#batchTail;
    let releaseBatch: (() => void) | undefined;
    this.#batchTail = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });

    await previousBatch;
    try {
      this.sqlite.exec("begin");
      try {
        const results: unknown[] = [];
        for (let index = 0; index < statements.length; index += 1) {
          if (this.failNextBatchAt === index) {
            this.failNextBatchAt = null;
            throw new Error("injected batch failure");
          }
          results.push(await statements[index].run());
        }
        this.sqlite.exec("commit");
        return results;
      } catch (error) {
        this.sqlite.exec("rollback");
        throw error;
      }
    } finally {
      releaseBatch?.();
    }
  }

  close(): void {
    this.sqlite.close();
  }
}

const actor: PersistenceActor = {
  tenantId: "email:alice@example.test",
  displayName: "Alice",
  email: "alice@example.test",
};
const otherActor: PersistenceActor = {
  tenantId: "email:bob@example.test",
  displayName: "Bob",
  email: "bob@example.test",
};
const rolesMod = "0x1111111111111111111111111111111111111111";
const safeAddress = "0x2222222222222222222222222222222222222222";

function policy(): DraftPolicy {
  return {
    chainId: 1,
    rolesMod,
    roles: [],
    allowances: [],
  };
}

test("D1 draft batches isolate tenants, roll back, and reject lost updates", async () => {
  const database = new TestD1();
  setDatabaseBinding(database as unknown as D1Database);
  try {
    // Bootstrap before fault injection, then prove the first insert is rolled
    // back when the second statement in createDraft's batch fails.
    assert.deepEqual(await listDrafts(actor, 1, rolesMod), []);
    database.failNextBatchAt = 1;
    await assert.rejects(
      createDraft(actor, {
        name: "must roll back",
        chainId: 1,
        rolesMod,
        safeAddress,
        policy: policy(),
      }),
      /injected batch failure/,
    );
    assert.deepEqual(await listDrafts(actor, 1, rolesMod), []);

    const created = await createDraft(actor, {
      name: "Policy",
      chainId: 1,
      rolesMod,
      safeAddress,
      policy: policy(),
    });
    assert.equal(created.version, 1);
    assert.equal((await listDrafts(actor, 1, rolesMod)).length, 1);
    assert.equal((await listDrafts(otherActor, 1, rolesMod)).length, 0);
    assert.equal(
      await getDraft(actor, created.id, {
        chainId: 1,
        rolesMod: "0x3333333333333333333333333333333333333333",
      }),
      null,
    );

    // Both callers present version 1. Exactly one batch may advance the row;
    // the other observes version 2 and receives an explicit conflict.
    const saves = await Promise.allSettled([
      saveDraft(actor, {
        draftId: created.id,
        chainId: 1,
        rolesMod,
        version: 1,
        name: "Alice edit",
        policy: policy(),
      }),
      saveDraft(actor, {
        draftId: created.id,
        chainId: 1,
        rolesMod,
        version: 1,
        name: "Concurrent edit",
        policy: policy(),
      }),
    ]);
    assert.equal(
      saves.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const rejected = saves.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    assert.ok(rejected);
    assert.ok(rejected.reason instanceof DraftVersionConflictError);

    const current = await getDraft(actor, created.id, { chainId: 1, rolesMod });
    assert.equal(current?.version, 2);
    const revisionCount = await database
      .prepare(
        "select count(*) as count from draft_revisions_v2 where draft_id = ?",
      )
      .bind(created.id)
      .first<number>("count");
    assert.equal(revisionCount, 2);
  } finally {
    setDatabaseBinding(null);
    database.close();
  }
});
