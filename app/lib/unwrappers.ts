/**
 * Transaction unwrappers: how the Roles modifier checks batched calls.
 *
 * A batch (Safe MultiSend, Morpho Bundler3) arrives as one blob of calldata, so
 * it cannot be matched against per-call permissions. With a unwrapper adapter set
 * for the batch contract and function, the modifier splits it and checks every
 * inner call against the role instead. Without one, role members cannot send
 * that batch at all.
 *
 * Only the official adapters below can be enabled from here: the adapter decides
 * which calls get through, so it must never be a user-supplied address. All
 * addresses and selectors come from the official Zodiac Roles app and were
 * checked to have code on Ethereum and Base.
 */
import { createPublicClient, getAddress, http, pad, parseAbi, toHex } from "viem";
import { Interface } from "ethers";
import { walletChains } from "./wallet-chains";

export const MULTISEND_SELECTOR = "0x8d80ff0a" as const; // multiSend(bytes)
export const MORPHO_MULTICALL_SELECTOR = "0x374f435d" as const; // multicall((address,bytes,uint256,bool,bytes32)[])
export const MULTISEND_UNWRAPPER = "0xB4Cd4bb764C089f20DA18700CE8bc5e49F369efD" as const;
export const MORPHO_BUNDLER3_UNWRAPPER = "0x7533922A155DC6b4Cc0ae4E74D70a73bc86dD3E8" as const;
/** An earlier MultiSend adapter that the official app flags for replacement. */
export const LEGACY_MULTISEND_UNWRAPPER = "0x93B7fCbc63ED8a3a24B59e1C3e6649D50B7427c0" as const;

export type UnwrapTarget = {
  id: string;
  label: string;
  explanation: string;
  selector: `0x${string}`;
  adapter: `0x${string}`;
  /** The batch contract on a chain, or null where there is no official deployment. */
  contract: (chainId: number) => `0x${string}` | null;
};

const MORPHO_BUNDLER3: Record<number, `0x${string}`> = {
  1: "0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245",
  8453: "0x6BFd8137e702540E7A42B74178A4a49Ba43920C4",
};

export const UNWRAP_TARGETS: readonly UnwrapTarget[] = [
  {
    id: "multisend-141",
    label: "Safe MultiSend 1.4.1",
    explanation: "Batches sent through Safe's standard MultiSend, as most Safe apps and bots produce.",
    selector: MULTISEND_SELECTOR,
    adapter: MULTISEND_UNWRAPPER,
    contract: () => "0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526",
  },
  {
    id: "multisend-callonly-141",
    label: "Safe MultiSendCallOnly 1.4.1",
    explanation: "The call-only variant of MultiSend. Safe's own UI uses it for batches without delegatecalls.",
    selector: MULTISEND_SELECTOR,
    adapter: MULTISEND_UNWRAPPER,
    contract: () => "0x9641d764fc13c8B624c04430C7356C1C7C8102e2",
  },
  {
    id: "morpho-bundler3",
    label: "Morpho Bundler3",
    explanation: "Morpho's batching contract, used to supply, borrow, repay and swap in one transaction.",
    selector: MORPHO_MULTICALL_SELECTOR,
    adapter: MORPHO_BUNDLER3_UNWRAPPER,
    contract: (chainId) => MORPHO_BUNDLER3[chainId] ?? null,
  },
];

export const unwrapTargetIds = UNWRAP_TARGETS.map((target) => target.id);

export function findUnwrapTarget(id: string): UnwrapTarget | undefined {
  return UNWRAP_TARGETS.find((target) => target.id === id);
}

/** Key of the modifier's `unwrappers` mapping: bytes20(to) followed by the 4-byte selector. */
export function unwrapperKey(to: string, selector: string): `0x${string}` {
  const left = BigInt(pad(to as `0x${string}`, { size: 32, dir: "right" }));
  const right = BigInt(pad(selector as `0x${string}`, { size: 32, dir: "right" })) >> 160n;
  return toHex(left | right, { size: 32 });
}

export type UnwrapStatus = "enabled" | "legacy" | "missing" | "unavailable";
export type UnwrapState = { status: UnwrapStatus; contract: `0x${string}` | null; current: string | null };

export type UnwrapperReader = {
  unwrapperOf(key: `0x${string}`): Promise<string>;
  hasCode(address: string): Promise<boolean>;
};

const unwrappersAbi = parseAbi(["function unwrappers(bytes32) view returns (address)"]);
const ZERO = "0x0000000000000000000000000000000000000000";

export function createUnwrapperReader(chainId: number, rolesMod: string): UnwrapperReader {
  const chain = walletChains.find((item) => item.id === chainId);
  if (!chain) throw new Error("Unsupported chain.");
  const client = createPublicClient({ chain, transport: http() });
  return {
    unwrapperOf: (key) => client.readContract({ address: getAddress(rolesMod), abi: unwrappersAbi, functionName: "unwrappers", args: [key] }),
    async hasCode(address) {
      const code = await client.getBytecode({ address: getAddress(address) });
      return Boolean(code && code !== "0x");
    },
  };
}

/** Reads the current adapter for every known batch contract straight from the chain. */
export async function readUnwrapperStates(chainId: number, reader: UnwrapperReader): Promise<Record<string, UnwrapState>> {
  const entries = await Promise.all(
    UNWRAP_TARGETS.map(async (target): Promise<[string, UnwrapState]> => {
      const contract = target.contract(chainId);
      if (!contract || !(await reader.hasCode(contract)) || !(await reader.hasCode(target.adapter))) {
        return [target.id, { status: "unavailable", contract, current: null }];
      }
      const current = await reader.unwrapperOf(unwrapperKey(contract, target.selector));
      const status: UnwrapStatus =
        current.toLowerCase() === target.adapter.toLowerCase() ? "enabled" : current.toLowerCase() === ZERO ? "missing" : "legacy";
      return [target.id, { status, contract, current: current.toLowerCase() === ZERO ? null : current }];
    }),
  );
  return Object.fromEntries(entries);
}

const rolesInterface = new Interface(["function setTransactionUnwrapper(address to, bytes4 selector, address adapter)"]);

export type UnwrapCall = { call: "setTransactionUnwrapper"; to: `0x${string}`; selector: `0x${string}`; adapter: `0x${string}` };

/** The owner-only call that enables one target, or null where it has no deployment on this chain. */
export function unwrapCallFor(id: string, chainId: number): UnwrapCall | null {
  const target = findUnwrapTarget(id);
  const contract = target?.contract(chainId);
  if (!target || !contract) return null;
  return { call: "setTransactionUnwrapper", to: contract, selector: target.selector, adapter: target.adapter };
}

export function encodeUnwrapCall(call: UnwrapCall): string {
  return rolesInterface.encodeFunctionData("setTransactionUnwrapper", [call.to, call.selector, call.adapter]);
}
