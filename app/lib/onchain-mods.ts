/**
 * Roles modifiers found by reading the Safe itself.
 *
 * The indexer lags behind the chain, so a modifier enabled a moment ago can be
 * missing from it. Enabled modules are read straight from the Safe and kept only
 * if they answer like a Roles modifier whose avatar is this Safe.
 */
import { createPublicClient, getAddress, http, parseAbi } from "viem";
import { walletChains } from "./wallet-chains";
import type { DiscoveredRolesMod } from "./roles-reader";
import type { RolesModifier } from "zodiac-roles-sdk";

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

/**
 * A modifier the indexer has not picked up yet.
 *
 * Only accepted when it answers like a Roles modifier and its Safe lists it as an
 * enabled module. Its roles cannot be read from the chain, so the returned
 * baseline is empty and callers must treat it as unindexed, never submit against it.
 */
export async function readUnindexedModifier(address: string, chainId: number, reader: ModuleReader = createChainReader(chainId)): Promise<RolesModifier | null> {
  const info = await reader.probe(address);
  if (!info || !(await reader.enabled(info.avatar, address))) return null;
  return { address: getAddress(address), owner: getAddress(info.owner), avatar: getAddress(info.avatar), target: getAddress(info.target), roles: [], allowances: [], multiSendAddresses: [] } as RolesModifier;
}
