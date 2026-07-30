import assert from "node:assert/strict";
import test from "node:test";
import type { Role as SdkRole, Allowance } from "zodiac-roles-sdk";
import { fingerprint, samePolicyScope } from "../app/lib/use-policy";
import { verifyModifier, type SafeHostInfo } from "../app/lib/use-safe";
import { verifyWalletForModifier } from "../app/lib/use-wallet";
import { submissionReferences } from "../app/lib/submission";

const safe = "0x1111111111111111111111111111111111111111";
const modifier = "0x2222222222222222222222222222222222222222";
const state = {
  roles: [] as SdkRole[],
  allowances: [] as Allowance[],
};

const info: SafeHostInfo = {
  safeAddress: safe,
  chainId: 1,
  threshold: 1,
  owners: ["0x3333333333333333333333333333333333333333"],
  isReadOnly: false,
  modules: null,
};

test("facts-only drift changes the indexed baseline fingerprint", async () => {
  const before = await fingerprint(state, {
    owner: safe,
    avatar: safe,
    target: safe,
  });
  const after = await fingerprint(state, {
    owner: "0x4444444444444444444444444444444444444444",
    avatar: safe,
    target: safe,
  });
  assert.notEqual(before, after);
});

test("an unknown Safe module check blocks instead of failing open", () => {
  const result = verifyModifier({
    info,
    owner: safe,
    avatar: safe,
    target: safe,
    rolesMod: modifier,
    chainId: 1,
    moduleEnabled: null,
  });
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /could not be verified/);
});

test("direct module evidence allows a coherent Safe modifier", () => {
  const result = verifyModifier({
    info,
    owner: safe,
    avatar: safe,
    target: safe,
    rolesMod: modifier,
    chainId: 1,
    moduleEnabled: true,
  });
  assert.deepEqual(result, { ok: true, problems: [] });
});

test("wallet mode rejects an owner EOA even if the modifier names it", () => {
  const result = verifyWalletForModifier({
    account: safe,
    chainId: 1,
    owner: safe,
    avatar: safe,
    target: safe,
    modifierChainId: 1,
    safeStatus: "invalid",
    moduleEnabled: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /not a valid Safe/);
});

test("scope identity is chain and address sensitive", () => {
  assert.equal(
    samePolicyScope(
      { chainId: 1, rolesMod: modifier.toUpperCase() },
      { chainId: 1, rolesMod: modifier },
    ),
    true,
  );
  assert.equal(
    samePolicyScope(
      { chainId: 10, rolesMod: modifier },
      { chainId: 1, rolesMod: modifier },
    ),
    false,
  );
});

test("submission references preserve their identifier kind", () => {
  assert.deepEqual(
    submissionReferences({ kind: "bundleId", bundleId: "wallet-bundle" }),
    ["wallet-bundle"],
  );
  assert.deepEqual(
    submissionReferences({
      kind: "txHashes",
      txHashes: ["0x01", "0x02"],
    }),
    ["0x01", "0x02"],
  );
});
