/**
 * Where the browser reads a chain's logs from.
 *
 * Etherscan is used when the user has entered a key; chains outside their plan
 * answer with an error and fall through. Blockscout is listed only for the
 * instances that answered without a key from a browser page (checked by hand
 * on 2026-11-04; their command-line bot protection does not apply to
 * browsers). Blockscout says this keyless per-instance API will be retired; a
 * host that stops answering just falls through. The chain's public RPC is
 * always last.
 */
import { createPublicClient, getAddress, http } from "viem";
import { getApiKey } from "./api-keys";
import { chainName } from "./chains";
import { explorerSource, rpcSource, validCacheEntry, type LogCache, type LogSource, type RpcRequest, type SpanMemory } from "./chain-logs";
import { localRead, localUpdate } from "./local-db";
import type { ChainLogAccess } from "./roles-reader";
import { walletChains } from "./wallet-chains";

const ETHERSCAN = "https://api.etherscan.io/v2/api";
/** Chains on Etherscan's free API plan, from its chain list (checked 2026-11-04). */
const ETHERSCAN_FREE: ReadonlySet<number> = new Set([1, 137, 146, 42161, 42220, 80094, 747474, 11155111]);
const BLOCKSCOUT: Readonly<Record<number, string>> = {
  1: "https://eth.blockscout.com/api",
  10: "https://explorer.optimism.io/api",
  137: "https://polygon.blockscout.com/api",
  8453: "https://base.blockscout.com/api",
  42161: "https://arbitrum.blockscout.com/api",
  57073: "https://explorer.inkonchain.com/api",
};

/**
 * The block the official Roles v2 mastercopy was deployed at, per chain (from
 * the Roles subgraph's network configs). No modifier can be older. Chains not
 * listed fall back to genesis and rely on finding the creation block.
 */
const ROLES_FLOOR: Readonly<Record<number, number>> = {
  1: 18_692_162,
  10: 121_084_080,
  56: 44_203_693,
  100: 31_222_929,
  137: 50_615_850,
  146: 17_490_295,
  1101: 16_677_236,
  8453: 13_191_709,
  42161: 176_504_820,
  42220: 31_208_942,
  43114: 44_247_166,
  80094: 784_481,
  84532: 14_533_494,
  747474: 34_537_900,
  11155111: 4_884_885,
};

/**
 * RPCs for log queries where the chain's default refuses them. Base's own
 * public RPC answers every eth_getLogs with a rate limit; publicnode serves
 * recent ranges (not archive ones), which is what reloads and the check
 * before signing need. Cold history comes from an explorer.
 */
const LOG_RPC: Readonly<Record<number, string>> = {
  8453: "https://base-rpc.publicnode.com",
};

const requests = new Map<number, RpcRequest>();
const rpcs = new Map<number, LogSource>();
const etherscans = new Map<string, LogSource>();

function rpcRequest(chainId: number): RpcRequest {
  let request = requests.get(chainId);
  if (!request) {
    const chain = walletChains.find((item) => item.id === chainId);
    if (!chain) throw new Error("Unsupported chain.");
    const client = createPublicClient({ chain, transport: http(LOG_RPC[chainId]) });
    request = (method, params) => client.request({ method, params } as never);
    requests.set(chainId, request);
  }
  return request;
}

export function chainLogAccess(chainId: number): ChainLogAccess {
  const request = rpcRequest(chainId);
  let rpc = rpcs.get(chainId);
  if (!rpc) {
    rpc = rpcSource({ request, memory: spanMemory(chainId) });
    rpcs.set(chainId, rpc);
  }

  const explorers: LogSource[] = [];
  const key = getApiKey("etherscan");
  if (key) {
    const id = `${chainId}:${key}`;
    let etherscan = etherscans.get(id);
    if (!etherscan) {
      // The free plan allows three calls a second.
      etherscan = explorerSource({ name: "Etherscan", url: ETHERSCAN, params: { chainid: String(chainId), apikey: key }, minInterval: 400 });
      etherscans.set(id, etherscan);
    }
    explorers.push(etherscan);
  }
  const blockscout = BLOCKSCOUT[chainId];
  if (blockscout) explorers.push(explorerSource({ name: "Blockscout", url: blockscout, params: {} }));

  return {
    explorers,
    rpc,
    request,
    floor: ROLES_FLOOR[chainId] ?? 0,
    creationBlock: key ? (address) => etherscanCreationBlock(chainId, address, key) : undefined,
    tooLong: (requests) => {
      const name = walletChains.find((item) => item.id === chainId)?.name ?? chainName(chainId);
      const cost = `Reading this modifier's history from the public ${name} RPC would take about ${requests.toLocaleString()} requests.`;
      if (ETHERSCAN_FREE.has(chainId)) {
        return key
          ? `${cost} Etherscan could not serve it either; check that your Etherscan key is valid and try again.`
          : `${cost} Add a free Etherscan API key under API keys and try again; the free plan covers ${name}.`;
      }
      return `${cost} Etherscan's free plan does not cover ${name}; add an Etherscan key on a paid plan under API keys and try again.`;
    },
    unavailable: (rateLimited) => {
      const name = walletChains.find((item) => item.id === chainId)?.name ?? chainName(chainId);
      const explorer = rateLimited
        ? "the free explorer allowance for this browser is used up for now (it resets within the hour)"
        : "no explorer could serve it";
      const fix = ETHERSCAN_FREE.has(chainId)
        ? key ? "check that your Etherscan key is valid" : "add a free Etherscan API key under API keys"
        : "add an Etherscan key on a paid plan under API keys";
      return `This modifier's history on ${name} could not be read: ${explorer}, and the public ${name} RPC keeps no history. Try again later, or ${fix}. Once read, it is kept in this browser and later visits only need recent blocks.`;
    },
  };
}

/**
 * What a chain's public RPC accepts per log query, kept in this browser for a
 * day so the next page loads do not probe the node again. Expiring lets a limit
 * lowered by a passing error recover. Only a convenience: without storage the
 * limit is simply learned again.
 */
const SPAN_MEMORY_MS = 24 * 60 * 60 * 1000;
function spanMemory(chainId: number): SpanMemory {
  const key = (shape: string) => `saferoles-rpc-span:${chainId}:${shape}`;
  return {
    load(shape) {
      try {
        const value = JSON.parse(localStorage.getItem(key(shape)) ?? "null") as { span?: unknown; ceiling?: unknown; savedAt?: unknown } | null;
        const span = Number(value?.span), ceiling = Number(value?.ceiling), savedAt = Number(value?.savedAt);
        const fresh = Number.isFinite(savedAt) && Date.now() - savedAt < SPAN_MEMORY_MS;
        return fresh && Number.isSafeInteger(span) && Number.isSafeInteger(ceiling) && span > 0 && ceiling >= span ? { span, ceiling } : null;
      } catch {
        return null;
      }
    },
    save(shape, value) {
      try {
        localStorage.setItem(key(shape), JSON.stringify({ ...value, savedAt: Date.now() }));
      } catch {
        // Storage is optional here.
      }
    },
  };
}

/** One Etherscan call instead of bisecting eth_getCode; null when the chain is not on the plan. */
async function etherscanCreationBlock(chainId: number, address: string, key: string): Promise<number | null> {
  const search = new URLSearchParams({ chainid: String(chainId), module: "contract", action: "getcontractcreation", contractaddresses: getAddress(address), apikey: key });
  const response = await fetch(`${ETHERSCAN}?${search}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) return null;
  const body = (await response.json()) as { status?: unknown; result?: unknown };
  const row = body.status === "1" && Array.isArray(body.result) ? (body.result[0] as { blockNumber?: unknown } | undefined) : undefined;
  const block = Number(row?.blockNumber);
  return Number.isSafeInteger(block) && block >= 0 ? block : null;
}

/** Logs older than the tail are kept in IndexedDB, one record per modifier. */
export const browserLogCache: LogCache = {
  async read(key) {
    return validCacheEntry(await localRead("chainlogs", key));
  },
  async write(key, entry) {
    await localUpdate("chainlogs", key, () => entry);
  },
};
