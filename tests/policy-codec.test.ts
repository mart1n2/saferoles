import assert from "node:assert/strict";
import test from "node:test";
import { Interface } from "ethers";
import {
  c,
  processPermissions,
  encodeKey,
  type Allowance,
  type Role as SdkRole,
} from "zodiac-roles-sdk";
import { adoptSignature, fromRolesMod, toSdkState } from "../app/lib/policy-codec";
import { buildPlan } from "../app/lib/policy-plan";
import type { DraftAllowance, DraftPolicy, DraftRole } from "../app/lib/policy";

const rolesMod = "0x1111111111111111111111111111111111111111";
const member = "0x2222222222222222222222222222222222222222";
const target = "0x3333333333333333333333333333333333333333";
const recipient = "0x4444444444444444444444444444444444444444";
const usdc = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const iface = new Interface([
  "function assignRoles(address module, bytes32[] roleKeys, bool[] memberOf)",
  "function allowTarget(bytes32 roleKey, address targetAddress, uint8 options)",
  "function revokeTarget(bytes32 roleKey, address targetAddress)",
  "function scopeTarget(bytes32 roleKey, address targetAddress)",
  "function allowFunction(bytes32 roleKey, address targetAddress, bytes4 selector, uint8 options)",
  "function revokeFunction(bytes32 roleKey, address targetAddress, bytes4 selector)",
  "function scopeFunction(bytes32 roleKey, address targetAddress, bytes4 selector, tuple(uint8 parent,uint8 paramType,uint8 operator,bytes compValue)[] conditions, uint8 options)",
  "function setAllowance(bytes32 key, uint128 balance, uint128 maxRefill, uint128 refill, uint64 period, uint64 timestamp)",
]);

function names(transactions: readonly { data: string }[]): string[] {
  return transactions.map(
    (transaction) => iface.parseTransaction({ data: transaction.data })?.name ?? "?",
  );
}

function policy(roles: DraftRole[], allowances: DraftAllowance[] = []): DraftPolicy {
  return { chainId: 1, rolesMod, roles, allowances };
}

function role(overrides: Partial<DraftRole> = {}): DraftRole {
  return {
    id: "role-1",
    key: "treasury_operator",
    name: "Treasury Operator",
    description: "",
    members: [],
    permissions: [],
    ...overrides,
  };
}

function allowance(overrides: Partial<DraftAllowance> = {}): DraftAllowance {
  return {
    id: "allowance-1",
    key: "daily_usdc",
    balance: "50000000000",
    maxRefill: "50000000000",
    refill: "50000000000",
    period: "86400",
    timestamp: "0",
    ...overrides,
  };
}

const emptyChain = { roles: [] as SdkRole[], allowances: [] as Allowance[] };

function plan(draft: DraftPolicy, current = emptyChain) {
  const { state, issues } = toSdkState(draft);
  return buildPlan({ rolesMod, current, desired: state, issues });
}

test("encodes a scoped transfer with an allowance-bounded amount", () => {
  const result = plan(
    policy(
      [
        role({
          members: [{ id: "m1", address: member }],
          permissions: [
            {
              id: "p1",
              name: "USDC",
              targetAddress: usdc,
              mode: "function",
              signature: "transfer(address,uint256)",
              send: false,
              delegatecall: false,
              conditions: [
                { id: "c1", paramIndex: 0, operator: "eq", value: recipient },
                { id: "c2", paramIndex: 1, operator: "withinAllowance", value: "daily_usdc" },
              ],
            },
          ],
        }),
      ],
      [allowance()],
    ),
  );

  assert.deepEqual(result.issues, []);
  assert.deepEqual(names(result.transactions), [
    "assignRoles",
    "scopeTarget",
    "scopeFunction",
    "setAllowance",
  ]);

  const scoped = iface.parseTransaction({
    data: result.transactions[2].data,
  });
  assert.equal(scoped?.args.conditions.length, 3);
  assert.equal(scoped?.args.conditions[1].operator, 16n); // EqualTo
  assert.equal(scoped?.args.conditions[2].operator, 28n); // WithinAllowance
});

test("a tuple parameter produces the child structure the modifier requires", () => {
  // The regression this guards: emitting a Tuple/Array condition with no
  // children passes local checks but reverts in Integrity.sol on execution,
  // after owners have already signed.
  const result = plan(
    policy([
      role({
        permissions: [
          {
            id: "p1",
            name: "Router",
            targetAddress: target,
            mode: "function",
            signature: "swap((bytes,address,uint256,uint256),uint256)",
            send: false,
            delegatecall: false,
            // The tuple itself is unconstrained; the bound is on its sibling.
            // The tuple node must still describe its members or execution reverts.
            conditions: [{ id: "c1", paramIndex: 1, operator: "lte", value: "10" }],
          },
        ],
      }),
    ]),
  );

  assert.deepEqual(result.issues, []);
  const scoped = iface
    .parseTransaction({ data: result.transactions[1].data })!;
  assert.equal(scoped.name, "scopeFunction");

  const conditions = scoped.args.conditions;
  const tupleIndex = conditions.findIndex(
    (condition: { paramType: bigint }) => condition.paramType === 3n,
  );
  assert.ok(tupleIndex >= 0, "expected a Tuple condition node");
  const children = conditions.filter(
    (condition: { parent: bigint }, index: number) =>
      Number(condition.parent) === tupleIndex && index !== tupleIndex,
  );
  assert.equal(children.length, 4, "tuple node must describe its four members");
});

test("an array parameter also produces children", () => {
  const result = plan(
    policy([
      role({
        permissions: [
          {
            id: "p1",
            name: "Batcher",
            targetAddress: target,
            mode: "function",
            signature: "batch(address[],uint256)",
            send: false,
            delegatecall: false,
            conditions: [{ id: "c1", paramIndex: 1, operator: "lte", value: "10" }],
          },
        ],
      }),
    ]),
  );

  assert.deepEqual(result.issues, []);
  const scoped = iface
    .parseTransaction({ data: result.transactions[1].data })!;
  const conditions = scoped.args.conditions;
  const arrayIndex = conditions.findIndex(
    (condition: { paramType: bigint }) => condition.paramType === 4n,
  );
  assert.ok(arrayIndex >= 0, "expected an Array condition node");
  const children = conditions.filter(
    (condition: { parent: bigint }, index: number) =>
      Number(condition.parent) === arrayIndex && index !== arrayIndex,
  );
  assert.ok(children.length > 0, "array node must describe its element type");
});

test("a condition beyond the function's arity blocks instead of being dropped", () => {
  const result = plan(
    policy([
      role({
        permissions: [
          {
            id: "p1",
            name: "USDC",
            targetAddress: usdc,
            mode: "function",
            signature: "transfer(address,uint256)",
            send: false,
            delegatecall: false,
            conditions: [
              { id: "c1", paramIndex: 5, operator: "eq", value: recipient },
            ],
          },
        ],
      }),
    ]),
  );

  assert.equal(result.transactions.length, 0);
  assert.match(result.issues[0].message, /takes 2 parameters/);
  assert.equal(result.issues[0].permissionId, "p1");
});

test("two conditions on one parameter are combined, not silently dropped", () => {
  const result = plan(
    policy([
      role({
        permissions: [
          {
            id: "p1",
            name: "Vault",
            targetAddress: target,
            mode: "function",
            signature: "withdraw(uint256)",
            send: false,
            delegatecall: false,
            conditions: [
              { id: "c1", paramIndex: 0, operator: "gt", value: "100" },
              { id: "c2", paramIndex: 0, operator: "lt", value: "1000" },
            ],
          },
        ],
      }),
    ]),
  );

  assert.deepEqual(result.issues, []);
  const scoped = iface
    .parseTransaction({ data: result.transactions[1].data })!;
  const operators = scoped.args.conditions.map((condition: { operator: bigint }) =>
    Number(condition.operator),
  );
  assert.ok(operators.includes(1), "expected an And node combining both bounds");
  assert.ok(operators.includes(17), "expected the GreaterThan bound");
  assert.ok(operators.includes(18), "expected the LessThan bound");
});

test("an address must stand alone — surrounding label text is rejected", () => {
  const result = plan(
    policy([
      role({
        permissions: [
          {
            id: "p1",
            name: "USDC",
            targetAddress: usdc,
            mode: "function",
            signature: "transfer(address,uint256)",
            send: false,
            delegatecall: false,
            conditions: [
              {
                id: "c1",
                paramIndex: 0,
                operator: "eq",
                value: `${recipient} · Operations Safe`,
              },
            ],
          },
        ],
      }),
    ]),
  );

  assert.equal(result.transactions.length, 0);
  assert.match(result.issues[0].message, /is not a 20-byte address/);
});

test("a target address with a corrupt checksum is rejected", () => {
  // Mixed case with a bad checksum means the address has been mistyped or
  // truncated somewhere. Granting permission on the wrong contract is the cost
  // of letting it through, so it blocks rather than reaching the encoder.
  const result = plan(
    policy([
      role({
        permissions: [
          {
            id: "p1",
            name: "USDC",
            // Correct address is 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48.
            targetAddress: "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
            mode: "function",
            signature: "transfer(address,uint256)",
            send: false,
            delegatecall: false,
            conditions: [],
          },
        ],
      }),
    ]),
  );

  assert.equal(result.transactions.length, 0);
  assert.match(result.issues[0].message, /is not a 20-byte address/);
});

test("an all-lowercase target address is accepted, as the indexer returns them", () => {
  const result = plan(
    policy([
      role({
        permissions: [
          {
            id: "p1",
            name: "USDC",
            targetAddress: usdc.toLowerCase(),
            mode: "function",
            signature: "transfer(address,uint256)",
            send: false,
            delegatecall: false,
            conditions: [],
          },
        ],
      }),
    ]),
  );

  assert.deepEqual(result.issues, []);
  assert.deepEqual(names(result.transactions), ["scopeTarget", "allowFunction"]);
});

test("a malformed signature is rejected rather than hashed into a selector", () => {
  const result = plan(
    policy([
      role({
        permissions: [
          {
            id: "p1",
            name: "Bogus",
            targetAddress: target,
            mode: "function",
            signature: "foo(notAType)",
            send: false,
            delegatecall: false,
            conditions: [],
          },
        ],
      }),
    ]),
  );

  assert.equal(result.transactions.length, 0);
  assert.match(result.issues[0].message, /Cannot parse/);
});

test("a withinAllowance condition referencing no allowance is blocked", () => {
  const result = plan(
    policy([
      role({
        permissions: [
          {
            id: "p1",
            name: "USDC",
            targetAddress: usdc,
            mode: "function",
            signature: "transfer(address,uint256)",
            send: false,
            delegatecall: false,
            conditions: [
              { id: "c1", paramIndex: 1, operator: "withinAllowance", value: "ghost_budget" },
            ],
          },
        ],
      }),
    ]),
  );

  assert.ok(
    result.issues.some((issue) => /referenced but not defined/.test(issue.message)),
  );
});

test("diffs against real chain state and revokes what the draft dropped", () => {
  // Deployed: the role can call transfer and approve.
  const { targets } = processPermissions([
    { targetAddress: usdc, signature: "transfer(address,uint256)" },
    { targetAddress: usdc, signature: "approve(address,uint256)" },
  ]);
  const current = {
    roles: [
      {
        key: encodeKey("treasury_operator"),
        members: [member as `0x${string}`],
        targets,
        annotations: [],
        lastUpdate: 0,
      },
    ],
    allowances: [] as Allowance[],
  };

  // Desired: only transfer, and the member is gone.
  const result = plan(
    policy([
      role({
        permissions: [
          {
            id: "p1",
            name: "USDC",
            targetAddress: usdc,
            mode: "function",
            signature: "transfer(address,uint256)",
            send: false,
            delegatecall: false,
            conditions: [],
          },
        ],
      }),
    ]),
    current,
  );

  assert.deepEqual(result.issues, []);
  const emitted = names(result.transactions);
  assert.ok(emitted.includes("revokeFunction"), "must revoke the dropped function");
  assert.ok(emitted.includes("assignRoles"), "must remove the dropped member");
  assert.ok(
    !emitted.includes("scopeTarget"),
    "must not re-scope a target that is already scoped on chain",
  );

  const removal = result.changes.find((change) => change.action === "Membership");
  assert.match(removal!.summary, /Remove the role/);
});

test("editing an allowance period preserves spent balance and refill window", () => {
  const current = {
    roles: [] as SdkRole[],
    allowances: [
      {
        key: encodeKey("daily_usdc"),
        balance: 12_000_000000n, // partially spent
        maxRefill: 50_000_000000n,
        refill: 50_000_000000n,
        period: 86_400n,
        timestamp: 1_700_000_000n,
      },
    ],
  };

  const result = plan(
    policy(
      [],
      [
        allowance({
          balance: "12000000",
          maxRefill: "50000000000",
          refill: "50000000000",
          period: "43200", // the only intended change
          timestamp: "1700000000",
        }),
      ],
    ),
    current,
  );

  assert.deepEqual(result.issues, []);
  const setAllowance = iface.parseTransaction({
    data: result.transactions[0].data,
  })!;
  assert.equal(setAllowance.args.period, 43_200n);
  assert.equal(setAllowance.args.timestamp, 1_700_000_000n);
  assert.equal(
    setAllowance.args.balance,
    12_000_000n,
    "balance must carry through rather than resetting to the ceiling",
  );
});

test("a display label never changes the calldata a permission encodes", () => {
  // signatureLabel exists so a list of permissions reads well. If it could reach
  // encoding, renaming a parameter would silently change which function is
  // permitted — the same hazard as scraping a value out of display text.
  const base = {
    id: "p1",
    name: "USDC",
    targetAddress: usdc,
    mode: "function" as const,
    signature: "transfer(address,uint256)",
    send: false,
    delegatecall: false,
    conditions: [],
  };

  const plain = plan(policy([role({ permissions: [base] })]));
  const labelled = plan(
    policy([
      role({
        permissions: [
          { ...base, signatureLabel: "transfer(address recipient, uint256 wei)" },
        ],
      }),
    ]),
  );
  const misleading = plan(
    policy([
      role({ permissions: [{ ...base, signatureLabel: "selfdestruct(address)" }] }),
    ]),
  );

  assert.deepEqual(plain.issues, []);
  assert.deepEqual(
    labelled.transactions,
    plain.transactions,
    "a truthful label changes nothing",
  );
  assert.deepEqual(
    misleading.transactions,
    plain.transactions,
    "even a label naming a different function changes nothing",
  );
});

test("adopting a signature records its readable form for display", () => {
  const adopted = adoptSignature(
    {
      id: "p1",
      name: "",
      targetAddress: usdc,
      mode: "function",
      signature: "",
      selector: "0xa9059cbb",
      send: false,
      delegatecall: false,
      conditions: [],
    },
    "transfer(address to, uint256 value)",
  );

  assert.equal(adopted.editable, true);
  assert.equal(
    adopted.permission.signature,
    "transfer(address,uint256)",
    "the canonical form is what gets stored for encoding",
  );
  assert.equal(
    adopted.permission.signatureLabel,
    "transfer(address to, uint256 value)",
  );
});

test("two roles sharing a key are blocked, not silently merged", () => {
  // A role is identified on chain by its key. The planner keeps one and drops
  // the other's members and permissions, with nothing to show it happened.
  // Reachable in practice: "Ops Team" and "ops-team" derive the same key.
  const result = plan(
    policy([
      role({ id: "a", key: "ops_team", name: "Ops Team", members: [{ id: "m1", address: member }] }),
      role({ id: "b", key: "ops_team", name: "ops-team", members: [{ id: "m2", address: recipient }] }),
    ]),
  );

  assert.equal(result.transactions.length, 0);
  assert.match(result.issues[0].message, /all use the role key "ops_team"/);
  assert.deepEqual(
    result.issues.map((issue) => issue.roleId).sort(),
    ["a", "b"],
    "both roles are flagged so either can be renamed",
  );
});

test("a role with no key is rejected rather than written under the zero key", () => {
  const result = plan(policy([role({ key: "   ", name: "" })]));
  assert.equal(result.transactions.length, 0);
  assert.match(result.issues[0].message, /has no key/);
});

test("whole-contract clearance alongside a scoped function is blocked", () => {
  // The SDK resolves this to full access with only a console warning, so the
  // editor would show a narrow permission while the proposal granted everything.
  const result = plan(
    policy([
      role({
        permissions: [
          {
            id: "p1",
            name: "USDC everything",
            targetAddress: usdc,
            mode: "target",
            signature: "",
            send: false,
            delegatecall: false,
            conditions: [],
          },
          {
            id: "p2",
            name: "USDC transfer",
            targetAddress: usdc,
            mode: "function",
            signature: "transfer(address,uint256)",
            send: false,
            delegatecall: false,
            conditions: [],
          },
        ],
      }),
    ]),
  );

  assert.equal(result.transactions.length, 0);
  assert.match(result.issues[0].message, /clears the entire contract/);
  assert.match(result.issues[0].message, /grants every function/);
});

test("the same member listed twice produces one assignment", () => {
  const result = plan(
    policy([
      role({
        members: [
          { id: "m1", address: member },
          { id: "m2", address: member.toLowerCase() },
        ],
      }),
    ]),
  );

  assert.deepEqual(result.issues, []);
  assert.deepEqual(names(result.transactions), ["assignRoles"]);
});

test("an unnamed allowance is rejected rather than written under a zero key", () => {
  const result = plan(policy([], [allowance({ key: "   " })]));
  assert.equal(result.transactions.length, 0);
  assert.match(result.issues[0].message, /give the allowance a key/);
});

test("two allowances sharing a key are rejected", () => {
  const result = plan(
    policy([], [allowance({ id: "a1" }), allowance({ id: "a2", key: "daily_usdc" })]),
  );
  assert.equal(result.transactions.length, 0);
  assert.match(result.issues[0].message, /duplicates the key/);
});

test("a balance above the ceiling is rejected", () => {
  const result = plan(
    policy([], [allowance({ balance: "99999999999999", maxRefill: "1000" })]),
  );
  assert.match(result.issues[0].message, /cannot exceed the maximum refill/);
});

test("risk is derived from the call, not from parameter labels", () => {
  const delegate = plan(
    policy([
      role({
        permissions: [
          {
            id: "p1",
            name: "Module",
            targetAddress: target,
            mode: "function",
            signature: "execute(bytes)",
            send: false,
            delegatecall: true,
            conditions: [],
          },
        ],
      }),
    ]),
  );
  assert.equal(delegate.risk, "Critical");
  assert.match(delegate.changes[1].rationale!, /Delegatecall/);

  const wholeTarget = plan(
    policy([
      role({
        permissions: [
          {
            id: "p1",
            name: "Anything",
            targetAddress: target,
            mode: "target",
            signature: "",
            send: false,
            delegatecall: false,
            conditions: [],
          },
        ],
      }),
    ]),
  );
  assert.equal(wholeTarget.risk, "High");
  assert.match(wholeTarget.changes[0].summary, /Allow every function/);

  const revocationOnly = plan(policy([role()]), {
    roles: [
      {
        key: encodeKey("treasury_operator"),
        members: [],
        targets: processPermissions([
          { targetAddress: usdc, signature: "transfer(address,uint256)" },
        ]).targets,
        annotations: [],
        lastUpdate: 0,
      },
    ],
    allowances: [],
  });
  assert.equal(revocationOnly.risk, "Low", "tightening the policy is not risky");
});

test("a scoped function whose every parameter passes is reported as unconstrained", () => {
  const result = plan(
    policy([
      role({
        permissions: [
          {
            id: "p1",
            name: "USDC",
            targetAddress: usdc,
            mode: "function",
            signature: "transfer(address,uint256)",
            send: false,
            delegatecall: false,
            conditions: [{ id: "c1", paramIndex: 0, operator: "pass", value: "" }],
          },
        ],
      }),
    ]),
  );
  const grant = result.changes.find((change) => change.action === "Grant")!;
  assert.equal(grant.risk, "High");
  assert.match(grant.rationale!, /No parameter is constrained|constrains nothing/);
});

test("imports on-chain state without inventing signatures", () => {
  const { targets } = processPermissions([
    { targetAddress: usdc, signature: "transfer(address,uint256)" },
  ]);
  const draft = fromRolesMod(
    {
      address: rolesMod as `0x${string}`,
      owner: "0x9999999999999999999999999999999999999999",
      avatar: "0x8888888888888888888888888888888888888888",
      target: "0x8888888888888888888888888888888888888888",
      roles: [
        {
          key: encodeKey("treasury_operator"),
          members: [member as `0x${string}`],
          targets,
          annotations: [],
          lastUpdate: 0,
        },
      ],
      allowances: [
        {
          key: encodeKey("daily_usdc"),
          balance: 1n,
          maxRefill: 2n,
          refill: 3n,
          period: 4n,
          timestamp: 5n,
        },
      ],
      multiSendAddresses: [],
    },
    1,
  );

  assert.equal(draft.roles[0].key, "treasury_operator");
  assert.equal(draft.roles[0].members[0].address, member);
  assert.equal(draft.roles[0].permissions[0].signature, "");
  assert.equal(draft.roles[0].permissions[0].selector, "0xa9059cbb");
  assert.equal(draft.allowances[0].key, "daily_usdc");
  assert.equal(draft.allowances[0].timestamp, "5");
});

test("adopting a signature requires it to hash to the stored selector", () => {
  const permission = {
    id: "p1",
    name: "",
    targetAddress: usdc,
    mode: "function" as const,
    signature: "",
    selector: "0xa9059cbb",
    send: false,
    delegatecall: false,
    conditions: [],
  };

  const wrong = adoptSignature(permission, "approve(address,uint256)");
  assert.equal(wrong.editable, false);
  assert.match(wrong.note!, /does not hash to/);
  assert.equal(wrong.permission.signature, "");

  const right = adoptSignature(permission, "transfer(address,uint256)");
  assert.equal(right.editable, true);
  assert.equal(right.permission.signature, "transfer(address,uint256)");
});

test("a wildcarded imported permission encodes from its selector alone", () => {
  // Regression: requiring a signature here made the permission unencodable,
  // which dropped its whole role out of the desired state.
  const result = plan(
    policy([
      role({
        permissions: [
          {
            id: "p1",
            name: "",
            targetAddress: usdc,
            mode: "function",
            signature: "",
            selector: "0xa9059cbb",
            send: false,
            delegatecall: false,
            conditions: [],
          },
        ],
      }),
    ]),
  );

  assert.deepEqual(result.issues, []);
  assert.deepEqual(names(result.transactions), ["scopeTarget", "allowFunction"]);
});

test("one invalid field never plans a mass revocation of everything else", () => {
  // Regression, and the most dangerous failure mode in the whole pipeline:
  // an unencodable permission removes its role from the desired state, and
  // absence reads to the planner as "revoke all of it".
  const current = {
    roles: [
      {
        key: encodeKey("treasury_operator"),
        members: [member as `0x${string}`],
        targets: processPermissions([
          { targetAddress: usdc, signature: "transfer(address,uint256)" },
          { targetAddress: usdc, signature: "approve(address,uint256)" },
        ]).targets,
        annotations: [],
        lastUpdate: 0,
      },
    ],
    allowances: [] as Allowance[],
  };

  const result = plan(
    policy([
      role({
        members: [{ id: "m1", address: member }],
        permissions: [
          {
            id: "p1",
            name: "USDC",
            targetAddress: usdc,
            mode: "function",
            signature: "transfer(address,uint256)",
            send: false,
            delegatecall: false,
            conditions: [],
          },
          {
            id: "p2",
            name: "Broken",
            targetAddress: usdc,
            mode: "function",
            signature: "approve(address,uint256)",
            send: false,
            delegatecall: false,
            // Malformed: no such parameter position.
            conditions: [{ id: "c1", paramIndex: 9, operator: "eq", value: recipient }],
          },
        ],
      }),
    ]),
    current,
  );

  assert.ok(result.issues.length > 0, "the malformed condition must be reported");
  assert.deepEqual(
    result.transactions,
    [],
    "no calls may be planned while any issue is unresolved",
  );
  assert.deepEqual(result.changes, []);
});

test("targets the permission model cannot reproduce are not incidentally revoked", () => {
  // A target scoped to zero functions grants nothing but is real on-chain state.
  // Importing it and changing something unrelated must not plan its cleanup.
  const danglingTarget = {
    address: target as `0x${string}`,
    clearance: 2 as const,
    executionOptions: 0 as const,
    functions: [],
  };
  const onChainRole: SdkRole = {
    key: encodeKey("treasury_operator"),
    members: [],
    targets: [
      ...processPermissions([
        { targetAddress: usdc, signature: "transfer(address,uint256)" },
      ]).targets,
      danglingTarget,
    ],
    annotations: [{ uri: "https://example.test/permissions", schema: "https://example.test/schema" }],
    lastUpdate: 0,
  };

  const draft = fromRolesMod(
    {
      address: rolesMod as `0x${string}`,
      owner: "0x9999999999999999999999999999999999999999",
      avatar: "0x8888888888888888888888888888888888888888",
      target: "0x8888888888888888888888888888888888888888",
      roles: [onChainRole],
      allowances: [],
      multiSendAddresses: [],
    },
    1,
  );

  assert.deepEqual(
    draft.roles[0].residualTargets?.map((entry) => entry.address),
    [target],
    "the unreproducible target must be preserved on the draft",
  );
  assert.equal(draft.roles[0].annotations?.length, 1, "annotations must survive import");

  const result = plan(policy(draft.roles, draft.allowances), {
    roles: [onChainRole],
    allowances: [],
  });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(
    result.transactions,
    [],
    "an untouched import must plan nothing — no revokeTarget, no postAnnotations",
  );
});

test("an imported condition too complex for the editor stays read-only and intact", () => {
  const { targets } = processPermissions([
    {
      targetAddress: usdc,
      signature: "transfer(address,uint256)",
      // "recipient is one of two addresses" — a real on-chain shape the flat
      // editor cannot represent.
      condition: c.calldataMatches(
        [c.or(c.eq(recipient), c.eq(member)), undefined],
        ["address", "uint256"],
      ),
    },
  ]);

  const draft = fromRolesMod(
    {
      address: rolesMod as `0x${string}`,
      owner: "0x9999999999999999999999999999999999999999",
      avatar: "0x8888888888888888888888888888888888888888",
      target: "0x8888888888888888888888888888888888888888",
      roles: [
        {
          key: encodeKey("ops"),
          members: [],
          targets,
          annotations: [],
          lastUpdate: 0,
        },
      ],
      allowances: [],
      multiSendAddresses: [],
    },
    1,
  );

  const imported = draft.roles[0].permissions[0];
  const adopted = adoptSignature(imported, "transfer(address,uint256)");
  assert.equal(adopted.editable, false);
  assert.match(adopted.note!, /cannot represent/);
  assert.ok(adopted.permission.rawCondition, "raw condition must be retained");

  // Re-planning against the same chain state must be a no-op: the imported
  // condition round-trips byte-for-byte rather than being approximated.
  const current = {
    roles: [
      {
        key: encodeKey("ops"),
        members: [],
        targets,
        annotations: [],
        lastUpdate: 0,
      },
    ],
    allowances: [] as Allowance[],
  };
  const result = plan(
    policy([
      role({
        key: "ops",
        permissions: [adopted.permission],
      }),
    ]),
    current,
  );
  assert.deepEqual(result.issues, []);
  assert.deepEqual(
    result.transactions,
    [],
    "importing then re-planning an untouched policy must produce no calls",
  );
});
