import { indexedDB, IDBKeyRange } from "fake-indexeddb";
Object.assign(globalThis, { indexedDB, IDBKeyRange });
import assert from "node:assert/strict";
import test from "node:test";
import { formKeys, writeSavedForm } from "../app/lib/form-drafts";
import { fromRolesMod, toSdkState } from "../app/lib/policy-codec";
import {
  PROPOSAL_BLOCK_MS,
  SENT_BLOCK_MS,
  clearSubmissionMark,
  diffTransactions,
  readSubmissionMarks,
  rememberSubmission,
  sentCount,
  statusAfter,
  submissionVerdict,
  transactionDigests,
  type SubmissionMark,
} from "../app/lib/submission-mark";

const rolesMod = "0x0f253F99a3AC0122cc9ef0d61e35F27d6d017269";
const usdc = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const member = "0x66e5C961140dbC5859A39853f2cCfA4fA4F7A07a";
const newMember = "0x1111111111111111111111111111111111111111";
const mod = {
  address: rolesMod, owner: rolesMod, avatar: rolesMod, target: rolesMod, multiSendAddresses: [], allowances: [],
  roles: [{
    key: "0x626f740000000000000000000000000000000000000000000000000000000000" as const, members: [member], annotations: [], lastUpdate: 1,
    targets: [{
      address: usdc, clearance: 2, executionOptions: 0, functions: [{
        selector: "0x095ea7b3" as const, wildcarded: false, executionOptions: 0,
        condition: { paramType: 5, operator: 5, children: [{ paramType: 1, operator: 16, compValue: "0x00000000000000000000000087870bca3f3fd6335c3f4ce8392d69350b4fa4e2", children: [] }] },
      }],
    }],
  }],
};
const base = { roles: mod.roles, allowances: mod.allowances } as never;
const h = (n: number) => n.toString(16).padStart(64, "0");

/** The indexed policy plus a new member and a new `transfer` permission: two transactions. */
function submittedDraft() {
  const draft = fromRolesMod(mod as never, 1);
  const role = draft.roles[0]!;
  role.members.push({ id: "member-new", address: newMember });
  const approve = role.permissions[0]!;
  role.permissions.push({ ...approve, id: "new-transfer", selector: undefined, rawCondition: undefined, signature: "transfer(address to, uint256 value)", conditions: [] });
  return draft;
}

function mark(overrides: Partial<SubmissionMark> = {}): SubmissionMark {
  return { id: "a", baseHash: h(1), status: "sent", sent: ["x", "y"], policy: submittedDraft(), savedAt: 1_000, ...overrides };
}

test("a submission blocks its baseline and any draft that repeats a sent call", () => {
  const verdict = (check: { stateHash: string; planned: string[]; outstanding: string[] }, m = mark()) =>
    submissionVerdict(m, check, 2_000);
  assert.equal(verdict({ stateHash: h(1), planned: [], outstanding: ["x", "y"] }), "blocks", "indexer still shows the baseline");
  assert.equal(verdict({ stateHash: h(2), planned: ["y"], outstanding: ["y"] }), "blocks", "indexer caught up partway");
  assert.equal(verdict({ stateHash: h(2), planned: ["z"], outstanding: ["y"] }), "open", "an unrelated draft may go ahead");
  assert.equal(verdict({ stateHash: h(2), planned: ["y"], outstanding: [] }), "settled", "every sent call is indexed");
  assert.equal(verdict({ stateHash: h(2), planned: [], outstanding: ["z"] }), "settled", "only unsent calls remain");
  assert.equal(
    verdict({ stateHash: h(2), planned: ["y"], outstanding: ["y"] }, mark({ sent: ["x"] })),
    "settled",
    "a partial send only holds back the calls that went out",
  );
});

test("a proposal stops blocking after its window; broadcast transactions hold much longer", () => {
  const check = { stateHash: h(1), planned: [], outstanding: ["x"] };
  assert.equal(submissionVerdict(mark({ status: "proposed" }), check, 1_000 + PROPOSAL_BLOCK_MS - 1), "blocks");
  assert.equal(submissionVerdict(mark({ status: "proposed" }), check, 1_000 + PROPOSAL_BLOCK_MS), "settled");
  for (const status of ["sent", "sending"] as const) {
    assert.equal(submissionVerdict(mark({ status }), check, 1_000 + PROPOSAL_BLOCK_MS), "blocks", status);
    assert.equal(submissionVerdict(mark({ status }), check, 1_000 + SENT_BLOCK_MS), "settled", status);
  }
  assert.equal(submissionVerdict(mark(), check, 500), "settled", "a record from the future is dropped");
});

test("a partly indexed sequential submission still blocks the calls that are not indexed", async () => {
  const draft = submittedDraft();
  const sentTxs = diffTransactions(draft, base, rolesMod);
  assert.equal(sentTxs.length, 2);
  const sent = await transactionDigests(sentTxs);
  const submitted = mark({ baseHash: h(1), sent, policy: draft, savedAt: Date.now() });

  // The indexer has seen the new member but not the new permission.
  const partly = { roles: [{ ...mod.roles[0], members: [member, newMember] }], allowances: [] } as never;
  const outstanding = await transactionDigests(diffTransactions(draft, partly, rolesMod));
  assert.equal(outstanding.length, 1);
  assert.ok(sent.includes(outstanding[0]!), "the rebuilt call is the one that already went out");
  assert.equal(submissionVerdict(submitted, { stateHash: h(2), planned: outstanding, outstanding }), "blocks");

  // Fully indexed: the submitted draft plans nothing more.
  const indexed = toSdkState(draft).state;
  assert.deepEqual(diffTransactions(draft, indexed, rolesMod), []);
  assert.equal(submissionVerdict(submitted, { stateHash: h(3), planned: [], outstanding: [] }), "settled");
});

test("what went out follows the submission result", () => {
  assert.equal(sentCount({ kind: "txHashes", txHashes: ["0x1"] }, 3), 1);
  assert.equal(sentCount({ kind: "bundleId", bundleId: "b" }, 3), 3);
  assert.equal(sentCount({ kind: "safeTxHash", safeTxHash: "0x2" }, 3), 3);
  assert.equal(statusAfter({ kind: "safeTxHash", safeTxHash: "0x2" }), "proposed");
  assert.equal(statusAfter({ kind: "txHashes", txHashes: [] }), "sent");
});

test("records survive a reload, one per submission, scoped to their modifier", async () => {
  const scope = { chainId: 1, rolesMod };
  assert.deepEqual(await readSubmissionMarks(scope), []);
  await rememberSubmission(scope, mark({ id: "one", baseHash: h(1), sent: [h(9)] }));
  // Stored under a differently cased address: still the same modifier.
  assert.equal(await rememberSubmission({ chainId: 1, rolesMod: rolesMod.toUpperCase().replace("0X", "0x") }, mark({ id: "two", baseHash: h(1), status: "sending", sent: [h(8)] })), true);

  const marks = (await readSubmissionMarks(scope)).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(marks.map((m) => [m.id, m.status, m.sent]), [["one", "sent", [h(9)]], ["two", "sending", [h(8)]]]);
  assert.equal(marks[0]!.policy.roles[0]!.members.length, 2);
  assert.ok(Date.now() - marks[0]!.savedAt < 5_000);
  assert.deepEqual(await readSubmissionMarks({ chainId: 10, rolesMod }), [], "another chain is unaffected");
  assert.deepEqual(await readSubmissionMarks({ chainId: 1, rolesMod: newMember }), [], "another modifier is unaffected");

  await clearSubmissionMark(scope, "one");
  await clearSubmissionMark(scope, "two");
  assert.deepEqual(await readSubmissionMarks(scope), []);
});

test("a malformed record is discarded", async () => {
  const scope = { chainId: 1, rolesMod };
  await writeSavedForm(formKeys.submitted(1, rolesMod, "bad"), { baseHash: "h1", status: "sent", sent: [], policy: submittedDraft() });
  await writeSavedForm(formKeys.submitted(1, rolesMod, "extra"), { baseHash: h(1), status: "sent", sent: [], policy: submittedDraft(), note: 1 });
  assert.deepEqual(await readSubmissionMarks(scope), []);
  assert.deepEqual(await readSubmissionMarks(scope), [], "and removed rather than read again");
});
