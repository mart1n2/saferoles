/**
 * Roles modifiers found by reading the Safe itself.
 *
 * Enabled modules are read straight from the Safe and kept only if they answer
 * like a Roles modifier whose avatar is this Safe.
 */
import { createPublicClient, getAddress, http, parseAbi } from "viem";
import { APPROVED_ROLES_MASTERCOPY } from "./setup-roles";
import { walletChains } from "./wallet-chains";
import type { DiscoveredRolesMod } from "./roles-reader";

const SENTINEL = "0x0000000000000000000000000000000000000001" as const;
const safeAbi = parseAbi(["function isModuleEnabled(address module) view returns (bool)", "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)"]);
const modAbi = parseAbi(["function owner() view returns (address)", "function avatar() view returns (address)", "function target() view returns (address)"]);

export type ModuleReader = {
  modules(safe: string): Promise<string[]>;
  probe(module: string): Promise<{ owner: string; avatar: string; target: string } | null>;
  /** True when the Safe lists `module` as enabled. */
  enabled(safe: string, module: string): Promise<boolean>;
};

export function createChainReader(chainId: number): ModuleReader {
  const chain = walletChains.find((item) => item.id === chainId);
  if (!chain) throw new Error("Unsupported chain.");
  const client = createPublicClient({ chain, transport: http() });
  return {
    async modules(safe) {
      const [array] = await client.readContract({ address: getAddress(safe), abi: safeAbi, functionName: "getModulesPaginated", args: [SENTINEL, 100n] });
      return [...array];
    },
    async enabled(safe, module) {
      try { return await client.readContract({ address: getAddress(safe), abi: safeAbi, functionName: "isModuleEnabled", args: [getAddress(module)] }); }
      catch { return false; }
    },
    async probe(module) {
      try {
        const address = getAddress(module);
        const [owner, avatar, target] = await Promise.all((["owner", "avatar", "target"] as const).map((functionName) => client.readContract({ address, abi: modAbi, functionName })));
        return { owner, avatar, target };
      } catch { return null; }
    },
  };
}

export async function discoverOnChain(safe: string, chainId: number, reader: ModuleReader = createChainReader(chainId)): Promise<DiscoveredRolesMod[]> {
  const found: DiscoveredRolesMod[] = [];
  for (const module of await reader.modules(safe)) {
    const info = await reader.probe(module);
    if (!info || info.avatar.toLowerCase() !== safe.toLowerCase()) continue;
    found.push({ address: getAddress(module), chainId, owner: getAddress(info.owner), avatar: getAddress(info.avatar), target: getAddress(info.target) });
  }
  return found;
}

/** Indexed results first, plus any module only the chain knows about. */
export function mergeMods<T extends { address: string; chainId: number }>(indexed: T[], onChain: T[]): T[] {
  const seen = new Set(indexed.map((mod) => `${mod.chainId}:${mod.address.toLowerCase()}`));
  return [...indexed, ...onChain.filter((mod) => !seen.has(`${mod.chainId}:${mod.address.toLowerCase()}`))];
}

/** Roles 2.1.0, the release the June 2026 security notice concerns; 2.1.1 is the pinned setup mastercopy. */
export const ROLES_MASTERCOPY_AFFECTED = "0x9646fDAD06d3e24444381f44362a3B0eB343D337";

export type MastercopyStatus = { status: "current" | "affected" | "unknown"; implementation: string | null };

/** The implementation an EIP-1167 minimal proxy delegates to, or null for any other code. */
export function proxyImplementation(code: string | undefined): string | null {
  const match = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i.exec(code ?? "");
  return match ? getAddress(`0x${match[1]}`) : null;
}

export function classifyMastercopy(implementation: string | null): MastercopyStatus {
  const lower = implementation?.toLowerCase();
  const status = lower === APPROVED_ROLES_MASTERCOPY.toLowerCase() ? "current" : lower === ROLES_MASTERCOPY_AFFECTED.toLowerCase() ? "affected" : "unknown";
  return { status, implementation };
}

/** Which Roles release a modifier runs, read from its proxy code. */
export async function readMastercopy(address: string, chainId: number): Promise<MastercopyStatus> {
  const chain = walletChains.find((item) => item.id === chainId);
  if (!chain) throw new Error("Unsupported chain.");
  const client = createPublicClient({ chain, transport: http() });
  return classifyMastercopy(proxyImplementation(await client.getBytecode({ address: getAddress(address) })));
}
