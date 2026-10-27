/** Browser-compatible, read-only adapter for the Roles indexer. No Zodiac account/API key. */
import { getAddress, isAddress } from "ethers";
import { chains, Clearance, ExecutionOptions, Operator, ParameterType, type Condition, type RolesModifier } from "zodiac-roles-sdk";

export const DEFAULT_ROLES_INDEXER = "https://gnosisguild.squids.live/roles:production/api/graphql";
export type DiscoveredRolesMod = { address: string; chainId: number; owner: string; avatar: string; target: string };
export interface RolesReader {
  discover(avatar: string, options?: RequestInit): Promise<DiscoveredRolesMod[]>;
  read(scope: { chainId: number; address: string }, options?: RequestInit): Promise<RolesModifier | null>;
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

export function createRolesReader({ endpoint = DEFAULT_ROLES_INDEXER, fetcher = fetch }: { endpoint?: string; fetcher?: typeof fetch } = {}): RolesReader {
  async function query(query: string, variables: Row, options: RequestInit = {}): Promise<Row> {
    const headers = new Headers(options.headers);
    headers.set("content-type", "application/json");
    const timeout = AbortSignal.timeout(15000);
    const response = await fetcher(endpoint, { ...options, method: "POST", headers, body: JSON.stringify({ query, variables }), signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout });
    if (!response.ok) throw new Error(`The Roles indexer returned ${response.status}.`);
    const body = row(await response.json());
    if (body.error || (Array.isArray(body.errors) && body.errors.length)) throw new Error("The Roles indexer rejected the query.");
    return row(body.data);
  }
  return {
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
