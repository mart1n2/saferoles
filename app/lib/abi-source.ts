/**
 * Contract ABI resolution.
 *
 * Runs server-side so lookups work from inside the Safe App iframe regardless of
 * each provider's CORS policy, and so an API key never reaches the browser.
 *
 * Order of preference:
 *  1. Sourcify — multi-chain, no API key, and it reports proxy implementations.
 *  2. Etherscan V2 multichain — only when a key is configured.
 *
 * Proxies matter here: scoping a permission on USDC needs `transfer`, which
 * lives in the implementation, not in the proxy's own ABI. When a proxy is
 * detected the implementation ABI is fetched and merged in.
 */
import { Fragment, FunctionFragment, Interface, getAddress } from "ethers";
import { runtimeVar } from "./runtime-env";

export type AbiSource = "sourcify" | "etherscan" | "manual";

export type ResolvedFunction = {
  /**
   * Canonical signature, e.g. `transfer(address,uint256)`.
   *
   * This is what the selector hashes from, so it is the only form that may reach
   * encoding. Never substitute {@link readable} for it.
   */
  signature: string;
  /**
   * Human-readable form with parameter names, e.g.
   * `transfer(address to, uint256 value)`.
   *
   * Display only. Types-only signatures leave a reviewer guessing which argument
   * is the recipient and which is the amount, which is exactly the judgement a
   * permission review depends on. Falls back to the canonical form when the ABI
   * declares no names.
   */
  readable: string;
  selector: string;
  name: string;
  /** Parameter names as declared, for labelling the condition editor. */
  inputs: { name: string; type: string }[];
  stateMutability: string;
  /** True when the function cannot change state and so is pointless to allow. */
  readOnly: boolean;
};

export type ResolvedAbi = {
  chainId: number;
  address: string;
  source: AbiSource;
  /** Contract name when the source reports one. */
  name: string | null;
  /** Implementation address when the target is a proxy. */
  implementation: string | null;
  proxyType: string | null;
  functions: ResolvedFunction[];
  /** The raw ABI, kept so a manual ABI can be stored and replayed. */
  abi: unknown[];
};

const SOURCIFY = "https://sourcify.dev/server/v2";
const ETHERSCAN = "https://api.etherscan.io/v2/api";

/**
 * Renders a function with its declared parameter names, the form explorers and
 * the Zodiac Roles app both use.
 *
 * `format("full")` would also prepend `function ` and append the return types,
 * neither of which means anything when granting permission to call something.
 * Parameters that carry no name fall back to their type alone, so the result
 * degrades to the canonical signature rather than inventing labels.
 */
export function readableSignature(fragment: FunctionFragment): string {
  const params = fragment.inputs.map((input) => input.format("full")).join(", ");
  return `${fragment.name}(${params})`;
}

/**
 * Extracts the callable, state-changing functions from an ABI.
 *
 * `view`/`pure` entries are marked read-only rather than dropped: seeing that a
 * function is a getter explains why granting it is meaningless.
 */
export function describeFunctions(abi: unknown[]): ResolvedFunction[] {
  const seen = new Set<string>();
  const functions: ResolvedFunction[] = [];

  for (const entry of abi) {
    let fragment: Fragment;
    try {
      fragment = Fragment.from(entry as never);
    } catch {
      continue;
    }
    if (!FunctionFragment.isFunction(fragment)) continue;

    const signature = fragment.format("sighash");
    if (seen.has(signature)) continue;
    seen.add(signature);

    functions.push({
      signature,
      readable: readableSignature(fragment),
      selector: fragment.selector,
      name: fragment.name,
      inputs: fragment.inputs.map((input, index) => ({
        name: input.name || `arg${index}`,
        type: input.type,
      })),
      stateMutability: fragment.stateMutability,
      readOnly:
        fragment.stateMutability === "view" || fragment.stateMutability === "pure",
    });
  }

  return functions.sort((a, b) => {
    if (a.readOnly !== b.readOnly) return a.readOnly ? 1 : -1;
    return a.signature.localeCompare(b.signature);
  });
}

/** Validates a user-supplied ABI and returns its callable functions. */
export function parseManualAbi(input: string): { abi: unknown[]; functions: ResolvedFunction[] } {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Paste an ABI.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Also accept the human-readable form, one signature per line.
    const lines = trimmed
      .split("\n")
      .map((line) => line.trim().replace(/,$/, ""))
      .filter(Boolean);
    const rejected = new Error(
      "That is neither valid JSON nor a list of function signatures. Paste the ABI array, or one signature per line.",
    );
    try {
      const iface = new Interface(lines);
      const abi = JSON.parse(iface.formatJson()) as unknown[];
      const functions = describeFunctions(abi);
      // ethers tolerates input it cannot turn into any fragment. Yielding an
      // empty ABI would leave an empty function picker and no explanation.
      if (functions.length === 0) throw rejected;
      return { abi, functions };
    } catch {
      throw rejected;
    }
  }

  // Some explorers wrap the ABI in an object.
  const abi = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { abi?: unknown[] })?.abi)
      ? (parsed as { abi: unknown[] }).abi
      : null;
  if (!abi) {
    throw new Error("Expected a JSON array of ABI entries.");
  }

  const functions = describeFunctions(abi);
  if (functions.length === 0) {
    throw new Error("That ABI declares no functions.");
  }
  return { abi, functions };
}

type SourcifyResponse = {
  abi?: unknown[];
  /** The contract name lives under `compilation`; there is no top-level `name`. */
  compilation?: { name?: string };
  proxyResolution?: {
    isProxy?: boolean;
    proxyType?: string | null;
    implementations?: { address: string; name?: string }[];
  };
};

/** Field selectors Sourcify v2 accepts. `name` is not one of them. */
const SOURCIFY_FIELDS = "abi,compilation,proxyResolution";

async function sourcify(
  chainId: number,
  address: string,
  fields: string,
  signal?: AbortSignal,
): Promise<SourcifyResponse | null> {
  // Sourcify rejects mixed-case addresses.
  const response = await fetch(
    `${SOURCIFY}/contract/${chainId}/${address.toLowerCase()}?fields=${fields}`,
    { signal, headers: { accept: "application/json" } },
  );
  if (response.status === 404) return null;
  if (!response.ok) return null;
  const body = (await response.json()) as SourcifyResponse & { customCode?: string };
  if (body.customCode) return null;
  return body;
}

async function fromSourcify(
  chainId: number,
  address: string,
  signal?: AbortSignal,
): Promise<ResolvedAbi | null> {
  const primary = await sourcify(chainId, address, SOURCIFY_FIELDS, signal);
  if (!primary?.abi) return null;

  const proxy = primary.proxyResolution;
  const implementation = proxy?.isProxy ? proxy.implementations?.[0] : undefined;

  let abi = primary.abi;
  let name = primary.compilation?.name ?? null;

  if (implementation?.address) {
    // The callable surface of a proxy is its implementation's.
    const target = await sourcify(chainId, implementation.address, SOURCIFY_FIELDS, signal);
    if (target?.abi) {
      const proxyOnly = describeFunctions(primary.abi).map((entry) => entry.selector);
      const merged = [...target.abi];
      // Keep proxy-level functions that the implementation does not define, so
      // admin entry points remain visible.
      for (const entry of primary.abi) {
        try {
          const fragment = Fragment.from(entry as never);
          if (
            FunctionFragment.isFunction(fragment) &&
            !describeFunctions(target.abi).some(
              (candidate) => candidate.selector === fragment.selector,
            ) &&
            proxyOnly.includes(fragment.selector)
          ) {
            merged.push(entry);
          }
        } catch {
          continue;
        }
      }
      abi = merged;
      name = implementation.name ?? target.compilation?.name ?? name;
    }
  }

  return {
    chainId,
    address: getAddress(address),
    source: "sourcify",
    name,
    implementation: implementation?.address ? getAddress(implementation.address) : null,
    proxyType: proxy?.isProxy ? (proxy.proxyType ?? "proxy") : null,
    functions: describeFunctions(abi),
    abi,
  };
}

async function fromEtherscan(
  chainId: number,
  address: string,
  signal?: AbortSignal,
): Promise<ResolvedAbi | null> {
  const key = runtimeVar("ETHERSCAN_API_KEY");
  if (!key) return null;

  const url = `${ETHERSCAN}?chainid=${chainId}&module=contract&action=getabi&address=${address}&apikey=${key}`;
  const response = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!response.ok) return null;
  const body = (await response.json()) as { status?: string; result?: string };
  if (body.status !== "1" || !body.result) return null;

  let abi: unknown[];
  try {
    abi = JSON.parse(body.result) as unknown[];
  } catch {
    return null;
  }

  return {
    chainId,
    address: getAddress(address),
    source: "etherscan",
    name: null,
    implementation: null,
    proxyType: null,
    functions: describeFunctions(abi),
    abi,
  };
}

/**
 * Resolves a contract's ABI, or null when no source has it verified.
 *
 * A null result is a normal outcome — unverified contracts exist — and the
 * caller offers manual entry instead.
 */
export async function resolveAbi(
  chainId: number,
  address: string,
  signal?: AbortSignal,
): Promise<ResolvedAbi | null> {
  for (const attempt of [fromSourcify, fromEtherscan]) {
    try {
      const resolved = await attempt(chainId, address, signal);
      if (resolved && resolved.functions.length > 0) return resolved;
    } catch {
      // Try the next source.
    }
  }
  return null;
}

/**
 * Looks up candidate signatures for 4-byte selectors.
 *
 * Used to make an imported policy readable when the target contract is not
 * verified. Candidates are only ever *suggestions*: a selector is a hash, so
 * collisions exist and the caller verifies before adopting one.
 */
export async function lookupSelectors(
  selectors: readonly string[],
  signal?: AbortSignal,
): Promise<Record<string, string[]>> {
  const unique = [...new Set(selectors.map((selector) => selector.toLowerCase()))].filter(
    (selector) => /^0x[0-9a-f]{8}$/.test(selector),
  );
  if (unique.length === 0) return {};

  const response = await fetch(
    `https://api.openchain.xyz/signature-database/v1/lookup?function=${unique.join(",")}`,
    { signal, headers: { accept: "application/json" } },
  );
  if (!response.ok) return {};

  const body = (await response.json()) as {
    ok?: boolean;
    result?: { function?: Record<string, { name: string; filtered?: boolean }[] | null> };
  };
  if (!body.ok || !body.result?.function) return {};

  const out: Record<string, string[]> = {};
  for (const [selector, matches] of Object.entries(body.result.function)) {
    const names = (matches ?? [])
      .filter((match) => !match.filtered)
      .map((match) => match.name);
    if (names.length > 0) out[selector.toLowerCase()] = names;
  }
  return out;
}
