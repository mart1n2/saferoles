import assert from "node:assert/strict";
import test from "node:test";
import { Interface, getAddress } from "ethers";
import {
  APPROVED_ROLES_MASTERCOPY,
  EXPECTED_FACTORY_RUNTIME_CODE_HASH,
  EXPECTED_ROLES_RUNTIME_CODE_HASH,
  MODULE_PROXY_FACTORY,
  REQUIRED_ROLES_FUNCTIONS,
  SUGGESTED_ROLES_MASTERCOPY,
  buildSetupPlan,
  checksPass,
  evaluateMastercopy,
  freshSaltNonce,
  runtimeCodeHash,
} from "../app/lib/setup-roles";

const safe = "0x849D52316331967b6fF1198e5E32A0eB168D039d";

const factoryInterface = new Interface([
  "function deployModule(address masterCopy, bytes initializer, uint256 saltNonce) returns (address)",
]);
const safeInterface = new Interface(["function enableModule(address module)"]);
const rolesInterface = new Interface(["function setUp(bytes initParams)"]);

function plan(overrides: { mastercopy?: string; saltNonce?: string } = {}) {
  return buildSetupPlan({
    safeAddress: safe,
    mastercopy: overrides.mastercopy ?? SUGGESTED_ROLES_MASTERCOPY,
    saltNonce: overrides.saltNonce ?? "1",
  });
}

const healthy = {
  mastercopy: SUGGESTED_ROLES_MASTERCOPY,
  code: "0x6080604052",
  abiName: "Roles",
  abiFunctions: [...REQUIRED_ROLES_FUNCTIONS],
  abiSource: "sourcify" as const,
  factoryCode: "0x6080604052",
  predictedCode: "0x",
};

test("the suggested mastercopy is a checksum-valid address", () => {
  // Guards against a hand-typed constant: a corrupt checksum here would fail
  // only at the moment someone tries to deploy.
  assert.equal(getAddress(SUGGESTED_ROLES_MASTERCOPY), SUGGESTED_ROLES_MASTERCOPY);
});

test("deploys through the Zodiac factory and enables the derived address", () => {
  const result = plan();
  assert.equal(result.transactions.length, 2);

  const [deploy, enable] = result.transactions;

  assert.equal(deploy.to, MODULE_PROXY_FACTORY, "deployment goes to the module factory");
  const parsedDeploy = factoryInterface.parseTransaction({ data: deploy.data })!;
  assert.equal(parsedDeploy.name, "deployModule");
  assert.equal(
    getAddress(parsedDeploy.args.masterCopy),
    getAddress(SUGGESTED_ROLES_MASTERCOPY),
  );
  assert.equal(parsedDeploy.args.saltNonce.toString(), "1");

  assert.equal(enable.to, getAddress(safe), "enableModule is a call from the Safe to itself");
  const parsedEnable = safeInterface.parseTransaction({ data: enable.data })!;
  assert.equal(parsedEnable.name, "enableModule");
  assert.equal(
    getAddress(parsedEnable.args.module),
    result.predictedAddress,
    "the address enabled must be the address the deployment creates",
  );

  assert.equal(deploy.value, "0");
  assert.equal(enable.value, "0");
});

test("the modifier is configured to be governed by, and act on, the Safe", () => {
  const result = plan();
  assert.deepEqual(result.configuration, {
    owner: getAddress(safe),
    avatar: getAddress(safe),
    target: getAddress(safe),
  });

  // The same three addresses must appear in the encoded setUp initializer.
  const parsedDeploy = factoryInterface.parseTransaction({
    data: result.transactions[0].data,
  })!;
  const setUp = rolesInterface.parseTransaction({ data: parsedDeploy.args.initializer })!;
  assert.equal(setUp.name, "setUp");
  const encoded = setUp.args.initParams.toLowerCase();
  assert.equal(
    (encoded.match(new RegExp(safe.slice(2).toLowerCase(), "g")) ?? []).length,
    3,
    "owner, avatar and target are all the Safe",
  );
});

test("the derived address is deterministic and salt-dependent", () => {
  assert.equal(plan({ saltNonce: "1" }).predictedAddress, plan({ saltNonce: "1" }).predictedAddress);
  assert.notEqual(
    plan({ saltNonce: "1" }).predictedAddress,
    plan({ saltNonce: "2" }).predictedAddress,
  );
});

test("an arbitrary mastercopy cannot be selected for setup", () => {
  assert.throws(
    () =>
      plan({
        mastercopy: "0x1111111111111111111111111111111111111111",
      }),
    /only supports the approved Roles mastercopy/,
  );
});

test("incomplete addresses are rejected before anything is encoded", () => {
  assert.throws(
    () => buildSetupPlan({ safeAddress: "0x1234", mastercopy: SUGGESTED_ROLES_MASTERCOPY, saltNonce: "1" }),
    /Safe address is not valid/,
  );
  assert.throws(
    () => buildSetupPlan({ safeAddress: safe, mastercopy: "0xabc", saltNonce: "1" }),
    /complete Roles mastercopy address/,
  );
});

test("setup pins the reviewed address and runtime identities", () => {
  assert.equal(SUGGESTED_ROLES_MASTERCOPY, APPROVED_ROLES_MASTERCOPY);
  assert.equal(
    EXPECTED_ROLES_RUNTIME_CODE_HASH,
    "0x471d8b3b419f1eb955230c0326c8812176df49bf3c7b414a563fda5a3c6c10b6",
  );
  assert.equal(
    EXPECTED_FACTORY_RUNTIME_CODE_HASH,
    "0x01623cbcf010a1c326230f1b2d5f48a66b440232ee49096102bc84967dc5f21e",
  );
  assert.equal(
    runtimeCodeHash("0x6080604052"),
    "0x1c3374235d773b2189aed115aa13143020fcdbbe86e38f358cf3e4771b2f0244",
  );
  assert.ok(
    checksPass([
      { id: "identity", label: "identity", status: "pass", detail: "pinned" },
    ]),
  );
});

test("an undeployed mastercopy fails", () => {
  const checks = evaluateMastercopy({ ...healthy, code: "0x" });
  assert.equal(checksPass(checks), false);
  const check = checks.find((entry) => entry.id === "deployed")!;
  assert.equal(check.status, "fail");
  assert.match(check.detail, /Nothing is deployed/);
});

test("a contract that is not Roles fails, even if deployed and verified", () => {
  const checks = evaluateMastercopy({ ...healthy, abiName: "MaliciousModule" });
  assert.equal(checksPass(checks), false);
  assert.match(
    checks.find((entry) => entry.id === "verified")!.detail,
    /not a Roles contract/,
  );
});

test("a Roles-named contract missing part of the interface fails", () => {
  const checks = evaluateMastercopy({
    ...healthy,
    abiFunctions: ["setUp", "owner", "avatar", "target"],
  });
  assert.equal(checksPass(checks), false);
  assert.match(checks.find((entry) => entry.id === "verified")!.detail, /missing: /);
});

test("an unverifiable mastercopy fails rather than being assumed good", () => {
  const checks = evaluateMastercopy({ ...healthy, abiName: null, abiFunctions: [] });
  assert.equal(checksPass(checks), false);
  assert.match(
    checks.find((entry) => entry.id === "verified")!.detail,
    /No published source/,
  );
});

test("a manually supplied ABI is rejected as identity evidence", () => {
  const checks = evaluateMastercopy({ ...healthy, abiSource: "manual" });
  assert.equal(checksPass(checks), false);
  assert.match(
    checks.find((entry) => entry.id === "verified")!.detail,
    /not independent identity evidence/,
  );
});

test("a missing module factory fails", () => {
  const checks = evaluateMastercopy({ ...healthy, factoryCode: "0x" });
  assert.equal(checksPass(checks), false);
  assert.match(checks.find((entry) => entry.id === "factory")!.detail, /not deployed/);
});

test("an already-occupied target address fails", () => {
  // Deploying over an existing proxy reverts, so this is caught before signing.
  const checks = evaluateMastercopy({ ...healthy, predictedCode: "0x6080" });
  assert.equal(checksPass(checks), false);
  assert.match(checks.find((entry) => entry.id === "vacant")!.detail, /already exists/);
});

test("a non-bytecode placeholder is never read as a deployed contract", () => {
  // Regression: passing a sentinel string when no provider was available made
  // "contract exists" pass for an address nobody had looked at.
  for (const code of ["0x-unknown", "unknown", "0x0", ""]) {
    const checks = evaluateMastercopy({ ...healthy, code });
    assert.equal(
      checks.find((entry) => entry.id === "deployed")!.status,
      "fail",
      `"${code}" must not count as deployed bytecode`,
    );
  }
});

test("checks are pending, not passing, while reads are outstanding", () => {
  const checks = evaluateMastercopy({
    mastercopy: SUGGESTED_ROLES_MASTERCOPY,
    code: null,
    abiName: null,
    abiFunctions: null,
    factoryCode: null,
    predictedCode: null,
  });
  assert.equal(checksPass(checks), false);
  assert.ok(checks.some((entry) => entry.status === "pending"));
  assert.ok(!checks.some((entry) => entry.status === "fail"));
});

test("salt nonces differ between setups", () => {
  assert.match(freshSaltNonce(), /^\d+$/);
});
