import assert from "node:assert/strict";
import test from "node:test";
import { Interface } from "ethers";
import {
  buildRolesTransactions,
  type PolicyRole,
} from "../app/lib/roles-transactions";

const rolesAddress = "0x1111111111111111111111111111111111111111";
const member = "0x2222222222222222222222222222222222222222";
const target = "0x3333333333333333333333333333333333333333";
const recipient = "0x4444444444444444444444444444444444444444";

const decoder = new Interface([
  "function assignRoles(address module, bytes32[] roleKeys, bool[] memberOf)",
  "function scopeTarget(bytes32 roleKey, address targetAddress)",
  "function allowFunction(bytes32 roleKey, address targetAddress, bytes4 selector, uint8 options)",
  "function scopeFunction(bytes32 roleKey, address targetAddress, bytes4 selector, tuple(uint8 parent,uint8 paramType,uint8 operator,bytes compValue)[] conditions, uint8 options)",
  "function setAllowance(bytes32 key, uint128 balance, uint128 maxRefill, uint128 refill, uint64 period, uint64 timestamp)",
]);

test("encodes member assignment and a wildcard function call", () => {
  const desired: PolicyRole[] = [
    {
      id: "operator",
      key: "operator",
      members: [{ address: member }],
      permissions: [
        {
          id: "transfer",
          address: target,
          signature: "transfer(address,uint256)",
          mode: "Function",
          execution: "Call",
          conditions: [],
        },
      ],
    },
  ];

  const result = buildRolesTransactions({
    rolesAddress,
    baseline: [],
    desired,
  });

  assert.deepEqual(result.issues, []);
  assert.deepEqual(
    result.transactions.map((transaction) => {
      const parsed = decoder.parseTransaction({ data: transaction.data });
      return parsed?.name;
    }),
    ["assignRoles", "scopeTarget", "allowFunction"],
  );
});

test("encodes flattened calldata conditions and an allowance", () => {
  const desired: PolicyRole[] = [
    {
      id: "operator",
      key: "operator",
      members: [],
      permissions: [
        {
          id: "transfer",
          address: target,
          signature: "transfer(address,uint256)",
          mode: "Function",
          execution: "Call",
          conditions: [
            {
              index: 0,
              operator: "Equal to",
              value: recipient,
            },
            {
              index: 1,
              operator: "Within allowance",
              value: "daily_usdc",
            },
          ],
          allowance: {
            key: "daily_usdc",
            amount: "50000000000",
            period: "86400",
          },
        },
      ],
    },
  ];

  const result = buildRolesTransactions({
    rolesAddress,
    baseline: [],
    desired,
  });

  assert.deepEqual(result.issues, []);
  assert.equal(result.transactions.length, 3);
  assert.equal(
    decoder.parseTransaction({ data: result.transactions[0].data })?.name,
    "setAllowance",
  );
  const scoped = decoder.parseTransaction({
    data: result.transactions[2].data,
  });
  assert.equal(scoped?.name, "scopeFunction");
  assert.equal(scoped?.args.conditions.length, 3);
  assert.equal(scoped?.args.conditions[1].operator, BigInt(16));
  assert.equal(scoped?.args.conditions[2].operator, BigInt(28));
});

test("blocks incomplete addresses instead of emitting ambiguous calldata", () => {
  const desired: PolicyRole[] = [
    {
      id: "operator",
      key: "operator",
      members: [{ address: "0x1234" }],
      permissions: [],
    },
  ];

  const result = buildRolesTransactions({
    rolesAddress,
    baseline: [],
    desired,
  });

  assert.equal(result.transactions.length, 0);
  assert.match(result.issues[0], /not a full address/);
});
