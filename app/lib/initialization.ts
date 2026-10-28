import { Interface } from "ethers";
/** First-role setup is planned only for a new, unoccupied deterministic proxy. */
import { buildSetupPlan, APPROVED_ROLES_MASTERCOPY } from "./setup-roles";
import { toSdkState } from "./policy-codec";
import { buildPlan, withUnwrappers } from "./policy-plan";
import { MULTISEND_SELECTOR, MULTISEND_UNWRAPPER, findUnwrapTarget, unwrapperKey } from "./unwrappers";
import type { DraftRole } from "./policy";

/**
 * Batches the new modifier supports from day one, as the official Zodiac app does:
 * both Safe MultiSend 1.4.1 contracts, so a Safe can send role members batches
 * that are checked call by call.
 */
export const INITIAL_UNWRAPPERS = ["multisend-141", "multisend-callonly-141"] as const;

export function buildInitializationPlan({ safeAddress, saltNonce, chainId, role }: {
  safeAddress: string; saltNonce: string; chainId: number; role: DraftRole;
}) {
  const setup = buildSetupPlan({ safeAddress, saltNonce, mastercopy: APPROVED_ROLES_MASTERCOPY });
  const { state, issues } = toSdkState({ chainId, rolesMod: setup.predictedAddress, roles: [role], allowances: [] });
  if (!role.name.trim()) issues.push({ message: "Give the first role a name." });
  if (!role.members.length) issues.push({ message: "Add at least one member to the first role." });
  if (!role.permissions.length) issues.push({ message: "Add at least one permission to the first role." });
  const policy = withUnwrappers(
    buildPlan({ rolesMod: setup.predictedAddress, current: { roles: [], allowances: [] }, desired: state, issues }),
    setup.predictedAddress,
    chainId,
    INITIAL_UNWRAPPERS,
  );
  if (policy.risk === "Critical") policy.issues.push({ message: "Delegatecall permissions are blocked. Remove them before initializing." });
  return {
    ...setup,
    issues: policy.issues,
    changes: policy.changes,
    // Order matters if a wallet has to confirm calls one by one: deploy, configure,
    // and enable last, so an interrupted run never leaves an enabled, half-configured module.
    transactions: policy.issues.length ? [] : [setup.transactions[0]!, ...policy.transactions, setup.transactions[1]!],
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
  const unwrappers = new Interface(["function unwrappers(bytes32) view returns (address)"]);
  for (const id of INITIAL_UNWRAPPERS) {
    const target = findUnwrapTarget(id)!;
    const contract = target.contract(0);
    if (!contract) continue;
    const raw = await readContract(modifierAddress, unwrappers.encodeFunctionData("unwrappers", [unwrapperKey(contract, MULTISEND_SELECTOR)]));
    if (!raw || String(unwrappers.decodeFunctionResult("unwrappers", raw)[0]).toLowerCase() !== MULTISEND_UNWRAPPER.toLowerCase()) {
      throw new Error("The MultiSend unwrapper is not set on the deployed modifier yet.");
    }
  }
  const enabled = await readContract(safeAddress, abi.encodeFunctionData("isModuleEnabled", [modifierAddress]));
  if (!enabled || abi.decodeFunctionResult("isModuleEnabled", enabled)[0] !== true) throw new Error("The Roles modifier is not verified as enabled on this Safe.");
}
