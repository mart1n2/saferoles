/**
 * Rebuilds a Roles v2 modifier's configuration from its own event logs.
 *
 * The public Roles indexer is no longer reachable, so the policy is replayed
 * from the chain instead. Every configuration change on a Roles v2 modifier
 * emits an event, and the official subgraph was built from exactly these
 * events. The handlers below mirror its mappings (zodiac-modifier-roles-v2,
 * packages/subgraph) so the result has the same shape and meaning as an
 * indexer response, and goes through the same `parseIndexedModifier`
 * validation before the editor sees it.
 *
 * Role annotations are not modifier events: they are posts on the Poster
 * contract, sent by the modifier's owner at the time and tagged
 * ROLES_PERMISSION_ANNOTATION.
 */
import { getAddress, Interface, type LogDescription } from "ethers";

export type RawLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  logIndex: number;
  transactionHash: string;
};

export const rolesEvents = new Interface([
  "event RolesModSetup(address indexed initiator, address indexed owner, address indexed avatar, address target)",
  "event AssignRoles(address module, bytes32[] roleKeys, bool[] memberOf)",
  "event SetDefaultRole(address module, bytes32 defaultRoleKey)",
  "event AvatarSet(address indexed previousAvatar, address indexed newAvatar)",
  "event TargetSet(address indexed previousTarget, address indexed newTarget)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
  "event AllowTarget(bytes32 roleKey, address targetAddress, uint8 options)",
  "event ScopeTarget(bytes32 roleKey, address targetAddress)",
  "event RevokeTarget(bytes32 roleKey, address targetAddress)",
  "event AllowFunction(bytes32 roleKey, address targetAddress, bytes4 selector, uint8 options)",
  "event ScopeFunction(bytes32 roleKey, address targetAddress, bytes4 selector, (uint8 parent, uint8 paramType, uint8 operator, bytes compValue)[] conditions, uint8 options)",
  "event RevokeFunction(bytes32 roleKey, address targetAddress, bytes4 selector)",
  "event SetAllowance(bytes32 allowanceKey, uint128 balance, uint128 maxRefill, uint128 refill, uint64 period, uint64 timestamp)",
  "event ConsumeAllowance(bytes32 allowanceKey, uint128 consumed, uint128 newBalance)",
  "event SetUnwrapAdapter(address to, bytes4 selector, address adapter)",
]);

const posterEvents = new Interface(["event NewPost(address indexed user, string content, string indexed tag)"]);

/** The Poster singleton, at the same address on every chain. */
export const POSTER_ADDRESS = "0x000000000000cd17345801aa8147b8D3950260FF";
export const NEW_POST_TOPIC = posterEvents.getEvent("NewPost")!.topicHash;
/** keccak256("ROLES_PERMISSION_ANNOTATION"), the indexed tag of an annotation post. */
export const ANNOTATION_TAG_TOPIC = "0xf8dcb30866f5e03a8ceb94d3a8bddff9952a5180ed69685773549bf21c526a1b";

// Clearance and ExecutionOptions as the contract numbers them.
const CLEARANCE_NONE = 0;
const CLEARANCE_TARGET = 1;
const CLEARANCE_FUNCTION = 2;
const OPTIONS_NONE = 0;

type FunctionState = { selector: string; wildcarded: boolean; executionOptions: number; condition: string | null };
type TargetState = { address: string; clearance: number; executionOptions: number; functions: Map<string, FunctionState> };
type RoleState = {
  key: string;
  lastUpdate: number;
  members: Set<string>;
  annotations: Map<string, string>;
  targets: Map<string, TargetState>;
};
type AllowanceState = { balance: bigint; maxRefill: bigint; refill: bigint; period: bigint; timestamp: bigint };

/** The indexer's GraphQL shape for one modifier, as `parseIndexedModifier` reads it. */
export type IndexedModifier = {
  address: string;
  owner: string;
  avatar: string;
  target: string;
  roles: {
    key: string;
    lastUpdate: number;
    members: { member: { address: string } }[];
    annotations: { uri: string; schema: string }[];
    targets: {
      address: string;
      clearance: number;
      executionOptions: number;
      functions: { selector: string; executionOptions: number; wildcarded: boolean; condition: { json: string } | null }[];
    }[];
  }[];
  allowances: { key: string; balance: string; maxRefill: string; refill: string; period: string; timestamp: string }[];
  unwrapAdapters: { targetAddress: string; selector: string; adapterAddress: string }[];
};

export function byChainOrder(a: RawLog, b: RawLog): number {
  return a.blockNumber - b.blockNumber || a.logIndex - b.logIndex;
}

type FlatCondition = { parent: bigint; paramType: bigint; operator: bigint; compValue: string };
type ConditionTree = { operator: number; paramType: number; compValue?: string; children?: ConditionTree[] };

/**
 * The flat, breadth-first condition list of a ScopeFunction event as the
 * subgraph's JSON tree: the first entry is the root, `compValue` is kept as
 * emitted and omitted when empty, and `children` only when there are any.
 */
export function conditionJson(flat: readonly FlatCondition[]): string {
  if (flat.length === 0) throw new Error("A scoped function has no conditions.");
  const nodes = flat.map((condition) => ({
    paramType: Number(condition.paramType),
    operator: Number(condition.operator),
    compValue: condition.compValue.toLowerCase(),
    children: [] as number[],
  }));
  flat.forEach((condition, index) => {
    const parent = Number(condition.parent);
    if (parent === index) return;
    if (parent >= index) throw new Error("Conditions are not ordered breadth-first.");
    nodes[parent]!.children.push(index);
  });
  const build = (index: number): ConditionTree => {
    const node = nodes[index]!;
    return {
      operator: node.operator,
      paramType: node.paramType,
      ...(node.compValue !== "0x" ? { compValue: node.compValue } : {}),
      ...(node.children.length ? { children: node.children.map(build) } : {}),
    };
  };
  return JSON.stringify(build(0));
}

/**
 * Replays the logs of one modifier (and the annotation posts about it), in
 * chain order. Returns null when they hold no RolesModSetup event: the address
 * is not a Roles v2 modifier.
 */
export function replayRolesModifier(modifier: string, logs: readonly RawLog[]): IndexedModifier | null {
  const self = modifier.toLowerCase();
  let facts: { owner: string; avatar: string; target: string } | null = null;
  const roles = new Map<string, RoleState>();
  const allowances = new Map<string, AllowanceState>();
  const adapters = new Map<string, { targetAddress: string; selector: string; adapterAddress: string }>();

  const role = (key: string, block: number): RoleState => {
    const id = key.toLowerCase();
    let found = roles.get(id);
    if (!found) {
      found = { key: id, lastUpdate: block, members: new Set(), annotations: new Map(), targets: new Map() };
      roles.set(id, found);
    }
    return found;
  };
  const target = (owner: RoleState, address: string): TargetState => {
    const id = address.toLowerCase();
    let found = owner.targets.get(id);
    if (!found) {
      found = { address: id, clearance: CLEARANCE_NONE, executionOptions: OPTIONS_NONE, functions: new Map() };
      owner.targets.set(id, found);
    }
    return found;
  };
  const allowance = (key: string): AllowanceState => {
    const id = key.toLowerCase();
    let found = allowances.get(id);
    if (!found) {
      found = { balance: 0n, maxRefill: 0n, refill: 0n, period: 0n, timestamp: 0n };
      allowances.set(id, found);
    }
    return found;
  };

  for (const log of [...logs].sort(byChainOrder)) {
    const source = log.address.toLowerCase();
    if (source === POSTER_ADDRESS.toLowerCase()) {
      if (facts) applyPost(log, self, facts.owner, role);
      continue;
    }
    if (source !== self) continue;

    let event: LogDescription | null;
    try {
      event = rolesEvents.parseLog({ topics: log.topics, data: log.data });
    } catch {
      continue;
    }
    if (!event) continue;
    const args = event.args;
    const block = log.blockNumber;

    if (event.name === "RolesModSetup") {
      if (!facts) facts = { owner: lower(args.owner), avatar: lower(args.avatar), target: lower(args.target) };
      continue;
    }
    // Every other handler needs the modifier to exist, as in the subgraph.
    if (!facts) continue;

    switch (event.name) {
      case "OwnershipTransferred":
        facts.owner = lower(args.newOwner);
        break;
      case "AvatarSet":
        facts.avatar = lower(args.newAvatar);
        break;
      case "TargetSet":
        facts.target = lower(args.newTarget);
        break;
      case "AssignRoles": {
        const member = lower(args.module);
        const keys: string[] = [...args.roleKeys];
        const memberOf: boolean[] = [...args.memberOf];
        keys.forEach((key, index) => {
          const existed = roles.has(key.toLowerCase());
          const assigned = role(key, block);
          const isMember = assigned.members.has(member);
          if (memberOf[index] && !isMember) {
            assigned.members.add(member);
            assigned.lastUpdate = block;
          } else if (!memberOf[index] && isMember) {
            assigned.members.delete(member);
            assigned.lastUpdate = block;
          } else if (!existed) {
            assigned.lastUpdate = block;
          }
        });
        break;
      }
      case "SetDefaultRole":
        role(args.defaultRoleKey, block);
        break;
      case "AllowTarget": {
        const scoped = role(args.roleKey, block);
        const allowed = target(scoped, args.targetAddress);
        allowed.clearance = CLEARANCE_TARGET;
        allowed.executionOptions = Number(args.options);
        scoped.lastUpdate = block;
        break;
      }
      case "ScopeTarget": {
        const scoped = role(args.roleKey, block);
        const narrowed = target(scoped, args.targetAddress);
        narrowed.clearance = CLEARANCE_FUNCTION;
        narrowed.executionOptions = OPTIONS_NONE;
        scoped.lastUpdate = block;
        break;
      }
      case "RevokeTarget": {
        // Revoking keeps the target and its functions, as the subgraph does.
        const revoked = roles.get(String(args.roleKey).toLowerCase())?.targets.get(lower(args.targetAddress));
        if (revoked) {
          revoked.clearance = CLEARANCE_NONE;
          revoked.executionOptions = OPTIONS_NONE;
        }
        break;
      }
      case "AllowFunction":
      case "ScopeFunction": {
        const scoped = role(args.roleKey, block);
        const owner = target(scoped, args.targetAddress);
        const selector = String(args.selector).toLowerCase();
        owner.functions.set(selector, {
          selector,
          wildcarded: event.name === "AllowFunction",
          executionOptions: Number(args.options),
          condition: event.name === "ScopeFunction" ? conditionJson(args.conditions as FlatCondition[]) : null,
        });
        scoped.lastUpdate = block;
        break;
      }
      case "RevokeFunction":
        roles.get(String(args.roleKey).toLowerCase())?.targets.get(lower(args.targetAddress))?.functions.delete(String(args.selector).toLowerCase());
        break;
      case "SetAllowance": {
        const values = [args.balance, args.maxRefill, args.refill, args.period, args.timestamp].map(BigInt);
        if (values.every((value) => value === 0n)) {
          allowances.delete(String(args.allowanceKey).toLowerCase());
        } else {
          const [balance, maxRefill, refill, period, timestamp] = values as [bigint, bigint, bigint, bigint, bigint];
          Object.assign(allowance(args.allowanceKey), { balance, maxRefill, refill, period, timestamp });
        }
        break;
      }
      case "ConsumeAllowance":
        allowance(args.allowanceKey).balance = BigInt(args.newBalance);
        break;
      case "SetUnwrapAdapter": {
        const id = `${lower(args.to)}.${String(args.selector).toLowerCase()}`;
        if (BigInt(args.adapter) === 0n) adapters.delete(id);
        else adapters.set(id, { targetAddress: lower(args.to), selector: String(args.selector).toLowerCase(), adapterAddress: lower(args.adapter) });
        break;
      }
    }
  }

  if (!facts) return null;
  // Lists come back in the subgraph's default order: by entity id.
  const sorted = <T>(values: Iterable<T>, by: (value: T) => string) => [...values].sort((a, b) => by(a).localeCompare(by(b)));
  return {
    address: getAddress(modifier),
    owner: facts.owner,
    avatar: facts.avatar,
    target: facts.target,
    roles: sorted(roles.values(), (r) => r.key).map((r) => ({
      key: r.key,
      lastUpdate: r.lastUpdate,
      members: sorted(r.members, (m) => m).map((address) => ({ member: { address } })),
      annotations: sorted(r.annotations, ([uri]) => uri).map(([uri, schema]) => ({ uri, schema })),
      targets: sorted(r.targets.values(), (t) => t.address).map((t) => ({
        address: t.address,
        clearance: t.clearance,
        executionOptions: t.executionOptions,
        functions: sorted(t.functions.values(), (f) => f.selector).map((f) => ({
          selector: f.selector,
          executionOptions: f.executionOptions,
          wildcarded: f.wildcarded,
          condition: f.condition === null ? null : { json: f.condition },
        })),
      })),
    })),
    allowances: sorted(allowances, ([key]) => key).map(([key, a]) => ({
      key,
      balance: String(a.balance),
      maxRefill: String(a.maxRefill),
      refill: String(a.refill),
      period: String(a.period),
      timestamp: String(a.timestamp),
    })),
    unwrapAdapters: sorted(adapters, ([id]) => id).map(([, adapter]) => adapter),
  };
}

function lower(value: unknown): string {
  return String(value).toLowerCase();
}

/** An annotation post counts only if the modifier's owner at that moment sent it. */
function applyPost(
  log: RawLog,
  modifier: string,
  owner: string,
  role: (key: string, block: number) => RoleState,
): void {
  if (log.topics[0]?.toLowerCase() !== NEW_POST_TOPIC || log.topics[2]?.toLowerCase() !== ANNOTATION_TAG_TOPIC) return;
  let event: LogDescription | null;
  try {
    event = posterEvents.parseLog({ topics: log.topics, data: log.data });
  } catch {
    return;
  }
  if (!event || lower(event.args.user) !== owner) return;

  let post: unknown;
  try {
    post = JSON.parse(String(event.args.content));
  } catch {
    return;
  }
  if (!post || typeof post !== "object" || Array.isArray(post)) return;
  const { rolesMod, roleKey, removeAnnotations, addAnnotations } = post as Record<string, unknown>;
  if (typeof rolesMod !== "string" || rolesMod.toLowerCase() !== modifier) return;
  // A key that is not bytes32 could never be read back as a role.
  if (typeof roleKey !== "string" || !/^0x[0-9a-f]{64}$/i.test(roleKey)) return;

  const key = roleKey.toLowerCase();
  let changed = false;
  for (const uri of Array.isArray(removeAnnotations) ? removeAnnotations : []) {
    if (typeof uri !== "string") continue;
    // `annotations` only exists once the role does; the change still counts.
    role(key, log.blockNumber).annotations.delete(uri);
    changed = true;
  }
  for (const entry of Array.isArray(addAnnotations) ? addAnnotations : []) {
    if (!entry || typeof entry !== "object") continue;
    const { uris, schema } = entry as Record<string, unknown>;
    if (!Array.isArray(uris) || typeof schema !== "string") continue;
    for (const uri of uris) {
      if (typeof uri !== "string") continue;
      const annotations = role(key, log.blockNumber).annotations;
      // An existing annotation keeps the schema it was first posted with.
      if (!annotations.has(uri)) annotations.set(uri, schema);
      changed = true;
    }
  }
  if (changed) role(key, log.blockNumber).lastUpdate = log.blockNumber;
}
