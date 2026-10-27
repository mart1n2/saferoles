import { Interface } from "ethers";
/** First-role setup is planned only for a new, unoccupied deterministic proxy. */
import { buildSetupPlan, APPROVED_ROLES_MASTERCOPY } from "./setup-roles";
import { toSdkState } from "./policy-codec";
import { buildPlan } from "./policy-plan";
import type { DraftRole } from "./policy";

export function buildInitializationPlan({ safeAddress, saltNonce, chainId, role }: {
  safeAddress: string; saltNonce: string; chainId: number; role: DraftRole;
}) {
  const setup = buildSetupPlan({ safeAddress, saltNonce, mastercopy: APPROVED_ROLES_MASTERCOPY });
  const { state, issues } = toSdkState({ chainId, rolesMod: setup.predictedAddress, roles: [role], allowances: [] });
  if (!role.name.trim()) issues.push({ message: "Give the first role a name." });
  if (!role.members.length) issues.push({ message: "Add at least one member to the first role." });
  if (!role.permissions.length) issues.push({ message: "Add at least one permission to the first role." });
  const policy = buildPlan({ rolesMod: setup.predictedAddress, current: { roles: [], allowances: [] }, desired: state, issues });
  if (policy.risk === "Critical") policy.issues.push({ message: "Delegatecall permissions are blocked. Remove them before initializing." });
  return {
    ...setup,
    issues: policy.issues,
    changes: policy.changes,
    transactions: policy.issues.length ? [] : [...setup.transactions, ...policy.transactions],
  };
}

export function suggestRoleKey(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 31);
}

/** Verify deployment independently of proposal identifiers and indexer lag. */
export async function verifyInitialization({ safeAddress, modifierAddress, getCode, readContract }: {
  safeAddress: string; modifierAddress: string;
  getCode: (address: string) => Promise<string | null>;
  readContract: (to: string, data: string) => Promise<string | null>;
}): Promise<void> {
  const expected = `0x363d3d373d3d3d363d73${APPROVED_ROLES_MASTERCOPY.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
  const code = await getCode(modifierAddress);
  if (code?.toLowerCase() !== expected) throw new Error("The expected Roles proxy is not deployed yet, or its implementation does not match.");
  const abi = new Interface(["function owner() view returns (address)", "function avatar() view returns (address)", "function target() view returns (address)", "function isModuleEnabled(address) view returns (bool)"]);
  const reads = await Promise.all(["owner", "avatar", "target"].map(async name => {
    const raw = await readContract(modifierAddress, abi.encodeFunctionData(name));
    if (!raw) throw new Error(`Could not read ${name} from the deployed modifier.`);
    return String(abi.decodeFunctionResult(name, raw)[0]);
  }));
  if (reads.some(address => address.toLowerCase() !== safeAddress.toLowerCase())) throw new Error("The modifier owner, avatar or target does not match this Safe.");
  const enabled = await readContract(safeAddress, abi.encodeFunctionData("isModuleEnabled", [modifierAddress]));
  if (!enabled || abi.decodeFunctionResult("isModuleEnabled", enabled)[0] !== true) throw new Error("The Roles modifier is not verified as enabled on this Safe.");
}
