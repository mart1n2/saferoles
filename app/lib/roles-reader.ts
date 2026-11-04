/**
 * Read-only access to a Roles v2 modifier's configuration. No Zodiac account
 * or API key is involved.
 *
 * The official Roles indexer is used whenever it answers; it was unreachable
 * for a while in 2026, so the configuration can also be replayed from the
 * modifier's event logs into the indexer's own response shape. Either way it is
 * validated here the same way: an incomplete snapshot is rejected, never read
 * as revocations.
 */
import { getAddress, isAddress } from "ethers";
import { chains, Clearance, ExecutionOptions, Operator, ParameterType, type Condition, type RolesModifier } from "zodiac-roles-sdk";
import { HistoryTooLong, HistoryUnavailable, readModifierLogs, type LogCache, type LogSource, type RpcRequest } from "./chain-logs";
import { replayRolesModifier } from "./roles-replay";

export const DEFAULT_ROLES_INDEXER = "https://gnosisguild.squids.live/roles:production/api/graphql";
export type DiscoveredRolesMod = { address: string; chainId: number; owner: string; avatar: string; target: string };
export interface RolesReader {
  /** Null when the address holds no Roles v2 modifier. */
  read(scope: { chainId: number; address: string }, options?: { signal?: AbortSignal }): Promise<RolesModifier | null>;
}
export interface IndexerReader extends RolesReader {
  /** One cheap query: true when the indexer answers at all. */
  probe(options?: { signal?: AbortSignal }): Promise<boolean>;
  /** Roles modifiers whose avatar is `avatar`, on every indexed chain. */
  discover(avatar: string, options?: { signal?: AbortSignal }): Promise<DiscoveredRolesMod[]>;
}

type Row = Record<string, unknown>;
function row(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed Roles indexer object.");
  return value as Row;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 10000) throw new Error("Malformed or oversized Roles indexer list.");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length > 1_000_000) throw new Error("Malformed Roles indexer string.");
  return value;
}
function address(value: unknown): `0x${string}` {
  if (!isAddress(text(value))) throw new Error("Malformed Roles indexer address.");
  return getAddress(value as string) as `0x${string}`;
}
function key(value: unknown): `0x${string}` {
  const result = text(value);
  if (!/^0x[0-9a-f]{64}$/i.test(result)) throw new Error("Malformed Roles indexer key.");
  return result.toLowerCase() as `0x${string}`;
}
function enumValue<T extends number>(value: unknown, values: Record<string, string | number>): T {
  const candidate = typeof value === "string" && !/^\d+$/.test(value) ? values[value] : value;
  if (typeof candidate !== "number" || !Object.values(values).includes(candidate)) throw new Error("Unknown Roles indexer enum.");
  return candidate as T;
}
function uint(value: unknown, bits: number): bigint {
  // The indexer sends small values as JSON numbers and large ones as strings.
  const asText = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
  if (typeof asText !== "string" || !/^\d{1,78}$/.test(asText)) throw new Error("Malformed Roles indexer integer.");
  const result = BigInt(asText);
  if (result >= (1n << BigInt(bits))) throw new Error("Roles indexer integer overflows its field.");
  return result;
}
function condition(value: unknown, depth = 0, budget = { count: 0 }): Condition {
  if (depth > 32 || ++budget.count > 2048) throw new Error("Roles indexer condition is too large.");
  const data = row(value);
  const compValue = data.compValue == null ? undefined : text(data.compValue);
  if (compValue && !/^0x(?:[0-9a-f]{2})*$/i.test(compValue)) throw new Error("Malformed Roles condition comparison value.");
  return {
    paramType: enumValue<ParameterType>(data.paramType, ParameterType),
    operator: enumValue<Operator>(data.operator, Operator),
    ...(compValue && compValue !== "0x" ? { compValue: compValue as `0x${string}` } : {}),
    ...(data.children == null ? {} : { children: list(data.children).map(child => condition(child, depth + 1, budget)) }),
  };
}

/** Reject incomplete policy snapshots instead of interpreting missing fields as revocations. */
export function parseIndexedModifier(value: unknown, expectedAddress: string): RolesModifier {
  const data = row(value);
  const actual = address(data.address);
  if (actual.toLowerCase() !== expectedAddress.toLowerCase()) throw new Error("The Roles indexer returned a different modifier address.");
  const roles = list(data.roles).map(value => {
    const role = row(value);
    if (!Number.isSafeInteger(role.lastUpdate) || Number(role.lastUpdate) < 0) throw new Error("Malformed Roles update timestamp.");
    return {
      key: key(role.key),
      members: list(role.members).map(value => address(row(row(value).member).address)),
      annotations: list(role.annotations).map(value => { const annotation = row(value); return { uri: text(annotation.uri), schema: text(annotation.schema) }; }),
      lastUpdate: Number(role.lastUpdate),
      targets: list(role.targets).map(value => {
        const target = row(value);
        return {
          address: address(target.address),
          clearance: enumValue<Clearance>(target.clearance, Clearance),
          executionOptions: enumValue<ExecutionOptions>(target.executionOptions, ExecutionOptions),
          functions: list(target.functions).map(value => {
            const fn = row(value);
            const selector = text(fn.selector);
            if (!/^0x[0-9a-f]{8}$/i.test(selector) || typeof fn.wildcarded !== "boolean") throw new Error("Malformed Roles function.");
            if (!fn.wildcarded && !fn.condition) throw new Error("A scoped function is missing its condition.");
            return {
              selector: selector.toLowerCase() as `0x${string}`,
              wildcarded: fn.wildcarded,
              executionOptions: enumValue<ExecutionOptions>(fn.executionOptions, ExecutionOptions),
              ...(fn.condition == null ? {} : { condition: condition(JSON.parse(text(row(fn.condition).json))) }),
            };
          }),
        };
      }),
    };
  });
  const allowances = list(data.allowances).map(value => {
    const allowance = row(value);
    return { key: key(allowance.key), balance: uint(allowance.balance,128), maxRefill: uint(allowance.maxRefill,128), refill: uint(allowance.refill,128), period: uint(allowance.period,64), timestamp: uint(allowance.timestamp,64) };
  });
  const multiSendAddresses = list(data.unwrapAdapters).flatMap(value => {
    const adapter = row(value);
    const implementation = address(adapter.adapterAddress).toLowerCase();
    const target = address(adapter.targetAddress);
    const selector = text(adapter.selector).toLowerCase();
    return selector === "0x8d80ff0a" && ["0x93b7fcbc63ed8a3a24b59e1c3e6649d50b7427c0", "0xb4cd4bb764c089f20da18700ce8bc5e49f369efd"].includes(implementation) ? [target] : [];
  });
  return { address: actual, owner: address(data.owner), avatar: address(data.avatar), target: address(data.target), roles, allowances, multiSendAddresses };
}

/** Where a chain's logs come from, built per read so a key entered later is used. */
export type ChainLogAccess = {
  explorers: LogSource[];
  rpc: LogSource;
  request: RpcRequest;
  floor: number;
  creationBlock?: (address: string) => Promise<number | null>;
  /** What to tell the user when the history is too long to read from the RPC. */
  tooLong?: (requests: number) => string;
  /** What to tell the user when no source can serve the history right now. */
  unavailable?: (rateLimited: boolean) => string;
};

export function createChainRolesReader({
  access,
  cache,
}: {
  access: (chainId: number) => ChainLogAccess;
  cache?: LogCache;
}): RolesReader {
  return {
    async read({ chainId, address: requested }, options) {
      if (!(chainId in chains)) throw new Error("Unsupported Roles chain.");
      const checked = address(requested);
      const sources = access(chainId);
      const logs = await readModifierLogs({
        chainId,
        address: checked,
        explorers: sources.explorers,
        rpc: sources.rpc,
        request: sources.request,
        floor: sources.floor,
        creationBlock: sources.creationBlock ? () => sources.creationBlock!(checked) : undefined,
        cache,
        signal: options?.signal,
      }).catch((error: unknown) => {
        if (error instanceof HistoryTooLong && sources.tooLong) throw new Error(sources.tooLong(error.requests), { cause: error });
        if (error instanceof HistoryUnavailable && sources.unavailable) throw new Error(sources.unavailable(error.rateLimited), { cause: error });
        throw error;
      });
      const replayed = replayRolesModifier(checked, logs);
      return replayed === null ? null : parseIndexedModifier(replayed, checked);
    },
  };
}

const POLICY_QUERY = `query RolesMod($id: ID!) {
  rolesModifier(id: $id) {
    address owner avatar target
    roles {
      key lastUpdate members { member { address } } annotations { uri schema }
      targets { address clearance executionOptions functions { selector executionOptions wildcarded condition { json } } }
    }
    allowances { key refill maxRefill period balance timestamp }
    unwrapAdapters { targetAddress selector adapterAddress }
  }
}`;
const DISCOVERY_QUERY = `query RolesModsForAvatar($avatar: String!) {
  rolesModifiers(avatar: $avatar) { address chainId owner avatar target }
}`;

/** The official Roles indexer (the one the Roles app itself queries). */
export function createIndexerReader({ endpoint = DEFAULT_ROLES_INDEXER, fetcher = fetch }: { endpoint?: string; fetcher?: typeof fetch } = {}): IndexerReader {
  async function query(query: string, variables: Row, options: { signal?: AbortSignal } = {}, timeoutMs = 15_000): Promise<Row> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ query, variables }),
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error(`The Roles indexer returned ${response.status}.`);
    const body = row(await response.json());
    if (body.error || (Array.isArray(body.errors) && body.errors.length)) throw new Error("The Roles indexer rejected the query.");
    return row(body.data);
  }
  return {
    async probe(options) {
      try {
        return (await query("query Probe { __typename }", {}, options, 6_000)).__typename !== undefined;
      } catch {
        return false;
      }
    },
    async discover(avatar, options) {
      const expected = address(avatar);
      const data = await query(DISCOVERY_QUERY, { avatar: expected.toLowerCase() }, options);
      return list(data.rolesModifiers).map(value => {
        const mod = row(value);
        if (!Number.isSafeInteger(mod.chainId) || !(Number(mod.chainId) in chains)) throw new Error("Unknown Roles indexer chain.");
        const actualAvatar = address(mod.avatar);
        if (actualAvatar.toLowerCase() !== expected.toLowerCase()) throw new Error("The Roles indexer returned a different Safe.");
        return { address: address(mod.address), chainId: Number(mod.chainId), owner: address(mod.owner), avatar: actualAvatar, target: address(mod.target) };
      });
    },
    async read({ chainId, address: requested }, options) {
      if (!(chainId in chains)) throw new Error("Unsupported Roles chain.");
      const checked = address(requested);
      const prefix = chains[chainId as keyof typeof chains].prefix;
      const data = await query(POLICY_QUERY, { id: `${prefix}:${checked.toLowerCase()}` }, options);
      return data.rolesModifier === null ? null : parseIndexedModifier(data.rolesModifier, checked);
    },
  };
}

/**
 * The official indexer when it answers, the chain otherwise.
 *
 * The indexer is probed once per page session, on first use; when it does not
 * answer, every read goes to the chain without retrying it. Each modifier
 * stays with the source that first served it: the two can list roles and
 * targets in a different order, and a baseline fingerprinted from one and
 * re-checked against the other would always look changed. A modifier the
 * indexer has not seen yet (deployed moments ago) is read from the chain.
 */
export function createPreferredRolesReader({ indexer, chain }: { indexer: IndexerReader; chain: RolesReader }): RolesReader & Pick<IndexerReader, "discover"> {
  let up: Promise<boolean> | null = null;
  const indexerUp = () => (up ??= indexer.probe());
  const chosen = new Map<string, "indexer" | "chain">();
  return {
    async read(scope, options) {
      const key = `${scope.chainId}:${scope.address.toLowerCase()}`;
      const source = chosen.get(key) ?? ((await indexerUp()) ? "indexer" : "chain");
      if (source === "indexer") {
        try {
          const mod = await indexer.read(scope, options);
          if (mod) {
            chosen.set(key, "indexer");
            return mod;
          }
        } catch (error) {
          if (options?.signal?.aborted) throw error;
          // Down since the probe: the chain serves the rest of the session.
          up = Promise.resolve(false);
        }
      }
      chosen.set(key, "chain");
      return chain.read(scope, options);
    },
    async discover(avatar, options) {
      if (!(await indexerUp())) return [];
      try {
        return await indexer.discover(avatar, options);
      } catch {
        return [];
      }
    },
  };
}
