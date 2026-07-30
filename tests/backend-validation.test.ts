import assert from "node:assert/strict";
import test from "node:test";
import {
  InputError,
  parse,
  parseDraftCreatePayload,
  parseProposalPayload,
  stringify,
} from "../app/lib/serialize";

const rolesMod = "0x1111111111111111111111111111111111111111";
const safeAddress = "0x2222222222222222222222222222222222222222";
const roleKey = `0x${"01".repeat(32)}`;
const referenceHash = `0x${"ab".repeat(32)}`;

function minimalPolicy(overrides: Record<string, unknown> = {}) {
  return {
    chainId: 1,
    rolesMod,
    roles: [],
    allowances: [],
    ...overrides,
  };
}

test("draft persistence validates and binds the embedded policy scope", () => {
  const parsed = parseDraftCreatePayload({
    name: "Policy update",
    chainId: 1,
    rolesMod,
    safeAddress,
    policy: minimalPolicy(),
    baseStateHash: "a".repeat(64),
  });
  assert.equal(parsed.chainId, 1);
  assert.equal(parsed.rolesMod.toLowerCase(), rolesMod);
  assert.equal(parsed.policy.rolesMod.toLowerCase(), rolesMod);

  assert.throws(
    () =>
      parseDraftCreatePayload({
        name: "Wrong scope",
        chainId: 1,
        rolesMod,
        safeAddress,
        policy: minimalPolicy({
          rolesMod: "0x3333333333333333333333333333333333333333",
        }),
      }),
    (error: unknown) =>
      error instanceof InputError && /scope must match/.test(error.message),
  );
});

test("draft persistence rejects unknown fields instead of storing arbitrary JSON", () => {
  assert.throws(
    () =>
      parseDraftCreatePayload({
        name: "Unexpected",
        chainId: 1,
        rolesMod,
        safeAddress,
        policy: minimalPolicy({ injected: true }),
      }),
    (error: unknown) =>
      error instanceof InputError && /injected is not a supported field/.test(error.message),
  );
});

test("proposal wire format safely revives bounded allowance bigints", () => {
  const wire = stringify({
    chainId: 1,
    rolesMod,
    safeAddress,
    submission: { kind: "safeTxHash", safeTxHash: referenceHash },
    risk: "Medium",
    calls: [
      {
        call: "setAllowance",
        key: roleKey,
        balance: 1n,
        maxRefill: 10n,
        refill: 2n,
        period: 60n,
        timestamp: 0n,
      },
    ],
  });
  const parsed = parseProposalPayload(JSON.parse(wire));
  assert.equal(parsed.submission.kind, "safeTxHash");
  assert.equal(parsed.calls[0].call, "setAllowance");
  if (parsed.calls[0].call === "setAllowance") {
    assert.equal(parsed.calls[0].maxRefill, 10n);
    assert.equal(parsed.calls[0].period, 60n);
  }
});

test("proposal validation rejects malformed bigint tags before persistence", () => {
  assert.throws(
    () =>
      parseProposalPayload({
        chainId: 1,
        rolesMod,
        safeAddress,
        submission: { kind: "safeTxHash", safeTxHash: referenceHash },
        calls: [
          {
            call: "setAllowance",
            key: roleKey,
            balance: { $bigint: "not-an-integer" },
            maxRefill: { $bigint: "10" },
            refill: { $bigint: "2" },
            period: { $bigint: "60" },
            timestamp: { $bigint: "0" },
          },
        ],
      }),
    (error: unknown) =>
      error instanceof InputError && /canonical non-negative integer/.test(error.message),
  );
});

test("proposal references are typed, bounded and internally consistent", () => {
  const hash = `0x${"cd".repeat(32)}`;
  assert.throws(
    () =>
      parseProposalPayload({
        chainId: 1,
        rolesMod,
        safeAddress,
        submission: { kind: "txHashes", txHashes: [hash, hash] },
        calls: [
          {
            call: "revokeTarget",
            roleKey,
            targetAddress: safeAddress,
          },
          {
            call: "scopeTarget",
            roleKey,
            targetAddress: safeAddress,
          },
        ],
      }),
    (error: unknown) =>
      error instanceof InputError && /duplicate hashes/.test(error.message),
  );

  assert.throws(
    () =>
      parseProposalPayload({
        chainId: 1,
        rolesMod,
        safeAddress,
        submission: { kind: "bundleId", bundleId: "bundle-1" },
        calls: [],
      }),
    (error: unknown) =>
      error instanceof InputError && /calls must not be empty/.test(error.message),
  );
});

test("tag objects with extra fields are not interpreted as bigint capabilities", () => {
  const value = parse<{ value: unknown }>(
    '{"value":{"$bigint":"1","unexpected":true}}',
  );
  assert.deepEqual(value.value, { $bigint: "1", unexpected: true });
});
