import test from "node:test";
import assert from "node:assert/strict";
import { baselineRoleFor, permissionChange, roleChanged } from "../app/lib/draft-changes";
import type { DraftPermission, DraftRole } from "../app/lib/policy";

const permission = (over: Partial<DraftPermission> = {}): DraftPermission => ({
  id: "p1", name: "USDC", targetAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", mode: "function",
  signature: "approve(address,uint256)", send: false, delegatecall: false, conditions: [], ...over,
});
const role = (permissions: DraftPermission[]): DraftRole => ({ id: "r1", key: "ops", name: "Ops", description: "", members: [], permissions });

test("an unchanged permission is not flagged", () => {
  assert.equal(permissionChange(role([permission()]), permission()), null);
});

test("adding an allowance condition marks the permission edited", () => {
  const withAllowance = permission({ conditions: [{ id: "c1", paramIndex: 1, operator: "withinAllowance" as never, value: "usd_daily" }] });
  assert.equal(permissionChange(role([permission()]), withAllowance), "edited");
});

test("a permission missing from the baseline is new, including under a new role", () => {
  assert.equal(permissionChange(role([]), permission()), "new");
  assert.equal(permissionChange(undefined, permission()), "new");
});

test("role changes include removed permissions", () => {
  const base = role([permission()]);
  assert.equal(roleChanged(base, base), false);
  assert.equal(roleChanged(base, role([])), true);
  assert.equal(roleChanged(undefined, base), true);
});

test("editing the role does not turn its permissions into New, even when local ids differ", () => {
  const base = role([permission({ id: "permission-1" })]);
  const reloaded = { ...role([permission({ id: "permission-9" })]), id: "role-9", name: "Renamed" };
  assert.equal(permissionChange(base, reloaded.permissions[0]), null);
  assert.equal(roleChanged(base, reloaded), true);
});

test("only the touched permission is flagged among several", () => {
  const other = permission({ id: "p2", targetAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7", signature: "transfer(address,uint256)" });
  const base = role([permission(), other]);
  const edited = { ...other, send: true };
  assert.equal(permissionChange(base, permission()), null);
  assert.equal(permissionChange(base, edited), "edited");
});

test("deployed roles are matched by their on-chain key, not local id", () => {
  const base = { ...role([permission()]), deployedKey: "0xabc", id: "role-1" };
  const draft = { ...role([permission()]), deployedKey: "0xabc", id: "role-7" };
  const policy = { chainId: 1, rolesMod: "0x0", roles: [base], allowances: [] };
  assert.equal(baselineRoleFor(policy, draft), base);
});

test("key order and undefined fields do not count as edits", () => {
  const base = role([permission()]);
  const restored = { ...permission(), conditions: [], delegatecall: false, send: false, signatureLabel: undefined };
  const reordered = Object.fromEntries(Object.entries(restored).reverse()) as unknown as DraftPermission;
  assert.equal(permissionChange(base, reordered), null);
});

test("adopting a signature for an imported selector is an edit, not a new permission", () => {
  const imported = permission({ signature: "", selector: "0x095ea7b3" });
  const adopted = permission({ signature: "approve(address,uint256)", selector: undefined, send: true });
  assert.equal(permissionChange(role([imported]), adopted), "edited");
  assert.equal(permissionChange(role([imported]), permission({ signature: "approve(address,uint256)", selector: undefined })), null);
});
