import { indexedDB, IDBKeyRange } from "fake-indexeddb";
Object.assign(globalThis, { indexedDB, IDBKeyRange });
import assert from "node:assert/strict";
import test from "node:test";
import {
  SUBMISSION_BLOCK_MS,
  clearSubmissionMark,
  readSubmissionMark,
  rememberSubmission,
  submissionBlocks,
} from "../app/lib/form-drafts";

const rolesMod = `0x${"a".repeat(40)}`;

test("a submission blocks only the baseline it was built on, and only for a while", () => {
  const mark = { baseHash: "h1", savedAt: 1_000 };
  assert.equal(submissionBlocks(mark, "h1", 1_000 + 5_000), true, "indexer still shows the old state");
  assert.equal(submissionBlocks(mark, "h2", 1_000 + 5_000), false, "indexer has moved on");
  assert.equal(submissionBlocks(mark, "h1", 1_000 + SUBMISSION_BLOCK_MS), false, "window over");
  assert.equal(submissionBlocks(mark, "h1", 500), false, "a mark from the future is ignored");
  assert.equal(submissionBlocks(null, "h1", 1_000), false, "nothing was submitted");
});

test("the mark survives a reload and is scoped to its modifier", async () => {
  assert.equal(await readSubmissionMark(1, rolesMod), null);
  await rememberSubmission(1, rolesMod, "hash-before");
  const mark = await readSubmissionMark(1, rolesMod);
  assert.equal(mark?.baseHash, "hash-before");
  assert.ok(mark && Date.now() - mark.savedAt < 5_000);
  assert.equal(await readSubmissionMark(10, rolesMod), null, "another chain is unaffected");
  assert.equal(await readSubmissionMark(1, `0x${"b".repeat(40)}`), null, "another modifier is unaffected");
  assert.equal(submissionBlocks(mark, "hash-before"), true);
  await clearSubmissionMark(1, rolesMod);
  assert.equal(await readSubmissionMark(1, rolesMod), null);
});

test("the modifier address is case-insensitive in the key", async () => {
  await rememberSubmission(1, rolesMod.toUpperCase().replace("0X", "0x"), "h");
  assert.equal((await readSubmissionMark(1, rolesMod))?.baseHash, "h");
  await clearSubmissionMark(1, rolesMod);
});
