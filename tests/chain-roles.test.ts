import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Interface, encodeBytes32String, zeroPadValue } from "ethers";
import { Clearance } from "zodiac-roles-sdk";
import { fromRolesMod, toSdkState } from "../app/lib/policy-codec";
import { buildPlan } from "../app/lib/policy-plan";
import {
  explorerSource,
  findCreationBlock,
  HistoryTooLong,
  namedSpanLimit,
  readModifierLogs,
  rpcSource,
  SourceUnavailable,
  TAIL_BLOCKS,
  type LogCacheEntry,
  type LogQuery,
  type LogSource,
  type RpcRequest,
} from "../app/lib/chain-logs";
import { createChainRolesReader, parseIndexedModifier } from "../app/lib/roles-reader";
import {
  ANNOTATION_TAG_TOPIC,
  conditionJson,
  NEW_POST_TOPIC,
  POSTER_ADDRESS,
  replayRolesModifier,
  rolesEvents,
  type RawLog,
} from "../app/lib/roles-replay";

type Fixture = { address: string; logs: Record<string, unknown>[] };
const quantity = (value: unknown) => (value === "0x" ? 0 : Number(BigInt(String(value))));
function loadFixture(name: string): { address: string; logs: RawLog[] } {
  const raw = JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Fixture;
  return {
    address: raw.address,
    logs: raw.logs.map((log) => ({
      address: String(log.address),
      topics: log.topics as string[],
      data: String(log.data),
      blockNumber: quantity(log.blockNumber),
      logIndex: quantity(log.logIndex),
      transactionHash: String(log.transactionHash),
    })),
  };
}
const fixture = loadFixture("roles-mod-mainnet-logs.json");
const realLogs = fixture.logs;
const safe = "0x75f4222113cd82ebad60c9b82aa1d2d86350937e";
const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

test("a real mainnet modifier replays to the configuration the Roles app shows", () => {
  const mod = parseIndexedModifier(replayRolesModifier(fixture.address, realLogs), fixture.address);
  assert.deepEqual([mod.owner, mod.avatar, mod.target].map((value) => value.toLowerCase()), [safe, safe, safe]);
  assert.equal(mod.roles.length, 1);
  const [role] = mod.roles;
  assert.equal(role!.key, encodeBytes32String("bot"));
  assert.deepEqual(role!.members.map((member) => member.toLowerCase()), ["0x66e5c961140dbc5859a39853f2ccfa4fa4f7a07a"]);
  assert.equal(role!.targets.length, 1);
  const [target] = role!.targets;
  assert.equal(target!.address.toLowerCase(), usdc);
  assert.equal(target!.clearance, Clearance.Function, "scoped to functions");
  assert.deepEqual(target!.functions.map((fn) => fn.selector), ["0x095ea7b3", "0xa9059cbb"]);
  assert.deepEqual(target!.functions[0]!.condition, {
    paramType: 5,
    operator: 5,
    children: [{ paramType: 1, operator: 16, compValue: "0x00000000000000000000000087870bca3f3fd6335c3f4ce8392d69350b4fa4e2" }],
  });
  assert.equal(mod.allowances.length, 1);
  assert.equal(mod.allowances[0]!.key, encodeBytes32String("usd_daily"));
  assert.equal(mod.allowances[0]!.maxRefill, 1_000_000_000n);
  assert.equal(mod.allowances[0]!.period, 86_400n);
});

test("an untouched replayed policy plans no calls", () => {
  const mod = parseIndexedModifier(replayRolesModifier(fixture.address, realLogs), fixture.address);
  const { state, issues } = toSdkState(fromRolesMod(mod, 1));
  const plan = buildPlan({ rolesMod: fixture.address, current: { roles: mod.roles, allowances: mod.allowances }, desired: state, issues });
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(plan.changes.map((change) => change.call.call), []);
});

test("a real Arbitrum modifier with revokes and a new owner matches the Roles app", () => {
  const arbitrum = loadFixture("roles-mod-arbitrum-logs.json");
  const mod = parseIndexedModifier(replayRolesModifier(arbitrum.address, arbitrum.logs), arbitrum.address);
  const newOwner = "0x0eb5b03c0303f2f47cd81d7be4275af8ed347576";
  assert.deepEqual([mod.owner, mod.avatar, mod.target].map((value) => value.toLowerCase()), [newOwner, newOwner, newOwner]);
  assert.equal(mod.roles.length, 1);
  const [role] = mod.roles;
  assert.equal(role!.key, encodeBytes32String("arc"));
  assert.deepEqual(role!.members.map((member) => member.toLowerCase()), ["0x83e3ca8ddebbd81c3bcdc3aa9e3afcd2bfb7c360"]);
  assert.equal(role!.targets.length, 7, "the Roles app counts revoked targets too");
  const active = role!.targets.filter((target) => target.clearance !== Clearance.None);
  assert.deepEqual(active.map((target) => target.address.toLowerCase()).sort(), [
    "0x467923b9ae90bdb36ba88eca11604d45f13b712c",
    "0x789fc99093b09ad01c34dc7251d0c89ce743e5a4",
    "0xab4b9080743f1ba17402793b5a3be2fe47a2b821",
    "0xf07ded9dc292157749b6fd268e37df6ea38395b9",
  ]);
  assert.deepEqual([...new Set(active.flatMap((target) => target.functions.map((fn) => fn.selector)))].sort(), [
    "0x01d24809", "0x11cfb046", "0x56781388", "0x5f398a14", "0x7b3c71d3", "0xb2704144",
  ]);
  const { state, issues } = toSdkState(fromRolesMod(mod, 42161));
  const plan = buildPlan({ rolesMod: arbitrum.address, current: { roles: mod.roles, allowances: mod.allowances }, desired: state, issues });
  assert.deepEqual(plan.changes, [], "an untouched replayed policy plans no calls");
});

test("logs that hold no RolesModSetup are not a Roles modifier", () => {
  assert.equal(replayRolesModifier(fixture.address, realLogs.filter((log) => log.topics[0] !== rolesEvents.getEvent("RolesModSetup")!.topicHash)), null);
  assert.equal(replayRolesModifier(fixture.address, []), null);
});

// ---------------------------------------------------------------- synthetic

const mod = "0x2222222222222222222222222222222222222222";
const owner = "0x1111111111111111111111111111111111111111";
const nextOwner = "0x4444444444444444444444444444444444444444";
const member = "0x5555555555555555555555555555555555555555";
const target = "0x3333333333333333333333333333333333333333";
const key = encodeBytes32String("ops");
const poster = new Interface(["event NewPost(address indexed user, string content, string indexed tag)"]);
let position = 0;

function event(name: string, values: unknown[], block: number, address = mod): RawLog {
  const { data, topics } = rolesEvents.encodeEventLog(name, values);
  return { address, topics, data, blockNumber: block, logIndex: position++, transactionHash: `0x${"ab".repeat(32)}` };
}
function post(user: string, content: unknown, block: number): RawLog {
  const encoded = poster.encodeEventLog("NewPost", [user, JSON.stringify(content), "ROLES_PERMISSION_ANNOTATION"]);
  return { address: POSTER_ADDRESS, topics: encoded.topics, data: encoded.data, blockNumber: block, logIndex: position++, transactionHash: `0x${"cd".repeat(32)}` };
}
const setup = (block = 1) => event("RolesModSetup", [owner, owner, owner, owner], block);

test("replay follows the subgraph's handlers for members, targets, functions, allowances and adapters", () => {
  const condition = [{ parent: 0, paramType: 5, operator: 5, compValue: "0x" }, { parent: 0, paramType: 1, operator: 16, compValue: zeroPadValue(member, 32) }];
  const replayed = replayRolesModifier(mod, [
    event("AssignRoles", [member, [key], [true]], 0), // before setup: ignored
    setup(1),
    event("AssignRoles", [member, [key], [true]], 2),
    event("AssignRoles", [owner, [key], [true]], 3),
    event("AssignRoles", [owner, [key], [false]], 4),
    event("ScopeTarget", [key, target], 5),
    event("ScopeFunction", [key, target, "0xa9059cbb", condition, 0], 6),
    event("AllowFunction", [key, target, "0x095ea7b3", 1], 7),
    event("RevokeFunction", [key, target, "0x095ea7b3"], 8),
    event("RevokeTarget", [key, target], 9),
    event("SetAllowance", [encodeBytes32String("a"), 10, 20, 5, 3600, 100], 10),
    event("SetAllowance", [encodeBytes32String("gone"), 1, 1, 1, 1, 1], 10),
    event("SetAllowance", [encodeBytes32String("gone"), 0, 0, 0, 0, 0], 11),
    event("ConsumeAllowance", [encodeBytes32String("a"), 4, 6], 12),
    event("SetUnwrapAdapter", [target, "0x8d80ff0a", "0x93b7fcbc63ed8a3a24b59e1c3e6649d50b7427c0"], 13),
    event("SetUnwrapAdapter", [owner, "0x8d80ff0a", "0x93b7fcbc63ed8a3a24b59e1c3e6649d50b7427c0"], 13),
    event("SetUnwrapAdapter", [owner, "0x8d80ff0a", "0x0000000000000000000000000000000000000000"], 14),
  ])!;
  const [role] = replayed.roles;
  assert.deepEqual(role!.members, [{ member: { address: member } }]);
  assert.equal(role!.lastUpdate, 7, "the last grant counts; revocations do not touch lastUpdate, as in the subgraph");
  const [revoked] = role!.targets;
  assert.equal(revoked!.clearance, 0, "a revoked target stays, without clearance");
  assert.deepEqual(revoked!.functions.map((fn) => fn.selector), ["0xa9059cbb"], "its scoped functions are kept");
  assert.equal(revoked!.functions[0]!.condition!.json, JSON.stringify({ operator: 5, paramType: 5, children: [{ operator: 16, paramType: 1, compValue: zeroPadValue(member, 32) }] }));
  assert.deepEqual(replayed.allowances.map((a) => [a.key, a.balance, a.maxRefill]), [[encodeBytes32String("a"), "6", "20"]]);
  assert.deepEqual(replayed.unwrapAdapters.map((a) => a.targetAddress), [target]);
  const parsed = parseIndexedModifier(replayed, mod);
  assert.equal(parsed.multiSendAddresses[0]!.toLowerCase(), target);
});

test("annotation posts count only from the owner of the time and for this modifier", () => {
  const add = (uri: string) => ({ rolesMod: mod, roleKey: key, addAnnotations: [{ uris: [uri], schema: "s" }] });
  const replayed = replayRolesModifier(mod, [
    setup(1),
    post(owner, add("https://kept"), 2),
    post(nextOwner, add("https://too-early"), 3),
    post(owner, { ...add("https://other-mod"), rolesMod: target }, 3),
    event("OwnershipTransferred", [owner, nextOwner], 4),
    post(owner, add("https://former-owner"), 5),
    post(nextOwner, add("https://new-owner"), 6),
    post(nextOwner, { rolesMod: mod, roleKey: key, removeAnnotations: ["https://kept"] }, 7),
  ])!;
  assert.deepEqual(replayed.roles[0]!.annotations.map((a) => a.uri), ["https://new-owner"]);
  assert.equal(replayed.roles[0]!.lastUpdate, 7);
  assert.equal(replayed.owner, nextOwner);
});

test("conditions are rebuilt breadth-first, as the subgraph stores them", () => {
  const flat = (parent: number, paramType = 1, operator = 0, compValue = "0x") => ({ parent: BigInt(parent), paramType: BigInt(paramType), operator: BigInt(operator), compValue });
  assert.equal(conditionJson([flat(0, 5, 5), flat(0), flat(0, 1, 16, "0xAB")]), JSON.stringify({ operator: 5, paramType: 5, children: [{ operator: 0, paramType: 1 }, { operator: 16, paramType: 1, compValue: "0xab" }] }));
  assert.throws(() => conditionJson([flat(0), flat(2), flat(0)]), /breadth-first/);
  assert.throws(() => conditionJson([]));
});

// ------------------------------------------------------------------ sources

function explorerFetcher(handler: (params: URLSearchParams) => unknown, calls: URLSearchParams[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const params = new URL(String(input)).searchParams;
    calls.push(params);
    return Response.json(handler(params));
  }) as typeof fetch;
}
const asExplorerLog = (log: RawLog) => ({ ...log, blockNumber: `0x${log.blockNumber.toString(16)}`, logIndex: log.logIndex === 0 ? "0x" : `0x${log.logIndex.toString(16)}` });

test("an explorer splits a full page, reads Etherscan's zero log index and combines topics", async () => {
  const logs = Array.from({ length: 1_500 }, (_, index) => ({ ...realLogs[0]!, blockNumber: index, logIndex: 0 }));
  const calls: URLSearchParams[] = [];
  const source = explorerSource({
    name: "Explorer",
    url: "https://explorer.test/api",
    params: { chainid: "1", apikey: "k" },
    fetcher: explorerFetcher((params) => {
      const from = Number(params.get("fromBlock")), to = Number(params.get("toBlock"));
      const page = logs.filter((log) => log.blockNumber >= from && log.blockNumber <= to).slice(0, 1_000).map(asExplorerLog);
      return page.length ? { status: "1", message: "OK", result: page } : { status: "0", message: "No records found", result: [] };
    }, calls),
  });
  const result = await source.getLogs({ address: fixture.address, fromBlock: 0, toBlock: 1_499, topics: [NEW_POST_TOPIC, null, ANNOTATION_TAG_TOPIC] });
  assert.equal(result.length, 1_500);
  assert.equal(result[0]!.logIndex, 0);
  assert.ok(calls.length >= 3, "the first range came back full and was split");
  assert.equal(calls[0]!.get("topic0"), NEW_POST_TOPIC);
  assert.equal(calls[0]!.get("topic2"), ANNOTATION_TAG_TOPIC);
  assert.equal(calls[0]!.get("topic0_2_opr"), "and");
  assert.equal(calls[0]!.get("topic1"), null, "an open position sends nothing");
  calls.length = 0;
  await source.getLogs({ address: fixture.address, fromBlock: 0, toBlock: 1, topics: [NEW_POST_TOPIC, zeroPadValue(owner, 32), ANNOTATION_TAG_TOPIC] });
  assert.deepEqual(["topic0_1_opr", "topic0_2_opr", "topic1_2_opr"].map((name) => calls[0]!.get(name)), ["and", "and", "and"], "Blockscout needs every pair");
  assert.equal(calls[0]!.get("apikey"), "k");
});

test("Blockscout's null-padded topics are read as the topics they pad", async () => {
  const log = { ...asExplorerLog(realLogs[0]!), topics: [...realLogs[0]!.topics, ...Array(4 - realLogs[0]!.topics.length).fill(null)] };
  const source = explorerSource({ name: "Blockscout", url: "https://explorer.test/api", params: {}, fetcher: explorerFetcher(() => ({ status: "1", message: "OK", result: [log] })) });
  const [read] = await source.getLogs({ address: fixture.address, fromBlock: 0, toBlock: 1 });
  assert.deepEqual(read!.topics, realLogs[0]!.topics);
  let throttled = 1;
  const busy = explorerSource({ name: "Blockscout", url: "https://explorer.test/api", params: {}, fetcher: (async () => (throttled-- > 0 ? new Response("slow down", { status: 429 }) : Response.json({ status: "1", message: "OK", result: [log] }))) as typeof fetch });
  assert.equal((await busy.getLogs({ address: fixture.address, fromBlock: 0, toBlock: 1 })).length, 1, "an HTTP 429 is retried");
  const spent = explorerSource({ name: "Blockscout", url: "https://explorer.test/api", params: {}, fetcher: (async () => new Response("", { status: 429, headers: { "x-ratelimit-remaining": "0" } })) as typeof fetch });
  await assert.rejects(spent.getLogs({ address: fixture.address, fromBlock: 0, toBlock: 1 }), SourceUnavailable, "a spent budget moves on at once");
  const empty = explorerSource({ name: "Blockscout", url: "https://explorer.test/api", params: {}, fetcher: explorerFetcher(() => ({ message: "No logs found", result: [], status: "0" })) });
  assert.deepEqual(await empty.getLogs({ address: fixture.address, fromBlock: 0, toBlock: 1 }), [], "its empty answer is not an error");
});

test("a chain outside the plan makes the explorer unavailable, not failed", async () => {
  const source = explorerSource({
    name: "Etherscan",
    url: "https://explorer.test/api",
    params: {},
    fetcher: explorerFetcher(() => ({ status: "0", message: "NOTOK", result: "Free API access is not supported for this chain. Please upgrade your api plan for full chain coverage." })),
  });
  await assert.rejects(source.getLogs({ address: fixture.address, fromBlock: 0, toBlock: 1 }), SourceUnavailable);
});

test("an explorer returning another contract's logs is an error", async () => {
  const source = explorerSource({ name: "Explorer", url: "https://explorer.test/api", params: {}, fetcher: explorerFetcher(() => ({ status: "1", result: [asExplorerLog({ ...realLogs[0]!, address: target })] })) });
  await assert.rejects(source.getLogs({ address: fixture.address, fromBlock: 0, toBlock: 1 }), /another contract/);
});

function fakeChain(logs: RawLog[], latest: number, { maxRange = Number.POSITIVE_INFINITY, createdAt = 0 } = {}) {
  const calls: { method: string; params: unknown[] }[] = [];
  const request: RpcRequest = async (method, params) => {
    calls.push({ method, params });
    if (method === "eth_blockNumber") return `0x${latest.toString(16)}`;
    if (method === "eth_getCode") return Number(BigInt(String(params[1]))) >= createdAt ? "0x6080" : "0x";
    if (method === "eth_getLogs") {
      const filter = params[0] as { address: string; topics?: (string | null)[]; fromBlock: string; toBlock: string };
      const from = Number(BigInt(filter.fromBlock)), to = Number(BigInt(filter.toBlock));
      if (to - from + 1 > maxRange) throw new Error(`query exceeds max block range ${maxRange}`);
      return logs
        .filter((log) => log.address.toLowerCase() === filter.address.toLowerCase() && log.blockNumber >= from && log.blockNumber <= to)
        .filter((log) => (filter.topics ?? []).every((topic, index) => topic === null || log.topics[index]?.toLowerCase() === topic.toLowerCase()))
        .map((log) => ({ ...log, blockNumber: `0x${log.blockNumber.toString(16)}`, logIndex: `0x${log.logIndex.toString(16)}` }));
    }
    throw new Error(`unexpected ${method}`);
  };
  return { request, calls };
}

test("the RPC narrows its span to the limit a node names, then reads everything", async () => {
  const logs = [setup(10), event("AssignRoles", [member, [key], [true]], 250_000)];
  const chain = fakeChain(logs, 300_000, { maxRange: 100_000 });
  const result = await rpcSource({ request: chain.request, initialSpan: 1_000_000 }).getLogs({ address: mod, fromBlock: 0, toBlock: 300_000 });
  assert.equal(result.length, 2);
  assert.ok(chain.calls.every((call) => call.method !== "eth_getLogs" || Number(BigInt((call.params[0] as { toBlock: string }).toBlock)) - Number(BigInt((call.params[0] as { fromBlock: string }).fromBlock)) < 1_000_000));
});

test("node limits are read from their errors, and a hopeless range stops at once", async () => {
  assert.equal(namedSpanLimit("query spans 99994 blocks (1 to 99994), but only 30000 are allowed for this request"), 30_000);
  assert.equal(namedSpanLimit("query exceeds max block range 100000"), 100_000);
  assert.equal(namedSpanLimit("exceed maximum block range: 50000"), 50_000);
  assert.equal(namedSpanLimit("Logs request reads 10001 blocks without the log index, over the maximum of 10000 blocks"), 10_000);
  assert.equal(namedSpanLimit("Internal error"), null);

  // Arbitrum's public RPC: 30,000 blocks per call, with the history hundreds of millions of blocks long.
  const chain = fakeChain([], 521_000_000, { maxRange: 30_000 });
  const rpc = rpcSource({ request: chain.request });
  await assert.rejects(rpc.getLogs({ address: mod, fromBlock: 176_504_820, toBlock: 520_999_000 }), (error) => error instanceof HistoryTooLong && error.requests > 10_000);
  assert.ok(chain.calls.filter((call) => call.method === "eth_getLogs").length <= 2, "it gives up after learning the limit");
  // A short range still works within the learned limit.
  assert.deepEqual(await rpc.getLogs({ address: mod, fromBlock: 0, toBlock: 100_000 }), []);
});

test("a rate limit is waited out rather than read as a range limit", async () => {
  const chain = fakeChain([setup(10)], 1_000);
  let limited = 1;
  const request: RpcRequest = async (method, params) => {
    if (method === "eth_getLogs" && limited-- > 0) {
      throw new Error('RPC Request failed. Status: 429 Request body: {"method":"eth_getLogs","params":[{"fromBlock":"0x0","toBlock":"0x3e8"}]} Details: request limit reached');
    }
    return chain.request(method, params);
  };
  const logs = await rpcSource({ request }).getLogs({ address: mod, fromBlock: 0, toBlock: 1_000 });
  assert.equal(logs.length, 1);
  const spans = chain.calls.filter((call) => call.method === "eth_getLogs").map((call) => (call.params[0] as { toBlock: string }).toBlock);
  assert.deepEqual(spans, ["0x3e8"], "retried with the same range, not a narrower one");
});

test("when the RPC refuses log queries, recent blocks come from the explorer", async () => {
  const logs = [setup(10), event("AssignRoles", [member, [key], [true]], 4_990)];
  const chain = fakeChain(logs, 5_000);
  const refusing: RpcRequest = async (method, params) => {
    if (method === "eth_getLogs") throw new Error("RPC Request failed. Status: 429 Details: request limit reached");
    return chain.request(method, params);
  };
  const explorer: LogSource = {
    name: "Explorer",
    getLogs: async (query) => logs.filter((log) => log.address === query.address && log.blockNumber >= query.fromBlock && log.blockNumber <= query.toBlock),
  };
  const read = await readModifierLogs({ chainId: 1, address: mod, explorers: [explorer], rpc: rpcSource({ request: refusing }), request: refusing, floor: 0 });
  assert.equal(read.length, 2, "the log in the tail is still found");
});

test("the explorer's small budget goes to cold history, not to reloads", async () => {
  const logs = [setup(10_000), event("AssignRoles", [member, [key], [true]], 20_000)];
  const chain = fakeChain(logs, 500_000);
  const store = new Map<string, LogCacheEntry>();
  const cache = { read: async (k: string) => store.get(k), write: async (k: string, entry: LogCacheEntry) => void store.set(k, structuredClone(entry)) };
  let explorerCalls = 0;
  const explorer: LogSource = {
    name: "Explorer",
    getLogs: async (query) => {
      explorerCalls++;
      return logs.filter((log) => log.address === query.address && log.blockNumber >= query.fromBlock && log.blockNumber <= query.toBlock);
    },
  };
  const read = (request: RpcRequest) => readModifierLogs({ chainId: 1, address: mod, explorers: [explorer], rpc: rpcSource({ request }), request, floor: 0, cache });

  assert.equal((await read(chain.request)).length, 2);
  assert.equal(explorerCalls, 2, "first read: one request for the modifier, one for its owner's posts");

  explorerCalls = 0;
  const later = fakeChain(logs, 520_000);
  assert.equal((await read(later.request)).length, 2);
  assert.equal(explorerCalls, 0, "a reload reads only the gap, from the RPC");

  explorerCalls = 0;
  const refusing: RpcRequest = async (method, params) => {
    if (method === "eth_getLogs") throw new Error("Status: 429 Details: request limit reached");
    return fakeChain(logs, 525_000).request(method, params);
  };
  assert.equal((await read(refusing)).length, 2);
  assert.equal(explorerCalls, 2, "where the RPC refuses logs, one explorer request per stream");
});

test("logs are cached up to the finalized block when the node reports one", async () => {
  const chain = fakeChain([setup(10)], 50_000);
  const request: RpcRequest = async (method, params) =>
    method === "eth_getBlockByNumber" && params[0] === "finalized" ? { number: "0xc346" } : chain.request(method, params); // 49,990
  const store = new Map<string, LogCacheEntry>();
  const cache = { read: async (k: string) => store.get(k), write: async (k: string, entry: LogCacheEntry) => void store.set(k, structuredClone(entry)) };
  await readModifierLogs({ chainId: 1, address: mod, explorers: [], rpc: rpcSource({ request }), request, floor: 0, cache });
  assert.equal(store.get(`1:${mod}`)!.modifier.syncedTo, 49_990);
});

test("the reader explains a history too long for the RPC", async () => {
  const chain = fakeChain([], 521_000_000, { maxRange: 30_000 });
  const reader = createChainRolesReader({ access: () => ({ explorers: [], rpc: rpcSource({ request: chain.request }), request: chain.request, floor: 176_504_820, tooLong: (requests) => `add a key (${requests})` }) });
  await assert.rejects(reader.read({ chainId: 42161, address: mod }), /add a key \(\d+\)/);
});

test("a node's limit is learned from the range tried, and remembered for the next load", async () => {
  // Polygon's free public RPC: about 100 blocks per call, behind a message that names 10,000.
  const strict = (calls: { method: string }[]): RpcRequest => async (method, params) => {
    calls.push({ method });
    const filter = params[0] as { fromBlock: string; toBlock: string };
    if (Number(BigInt(filter.toBlock)) - Number(BigInt(filter.fromBlock)) + 1 > 100) throw new Error("ranges over 10000 blocks are not supported on free plan");
    return [];
  };
  const saved = new Map<string, { span: number; ceiling: number }>();
  const memory = { load: (shape: string) => saved.get(shape) ?? null, save: (shape: string, value: { span: number; ceiling: number }) => void saved.set(shape, value) };
  const first: { method: string }[] = [];
  await rpcSource({ request: strict(first), memory }).getLogs({ address: mod, fromBlock: 0, toBlock: 1_008 });
  assert.ok(first.length <= 16, `learned within a few calls (${first.length})`);
  const second: { method: string }[] = [];
  await rpcSource({ request: strict(second), memory }).getLogs({ address: mod, fromBlock: 0, toBlock: 1_008 });
  assert.ok(second.length < first.length, "the next page load starts from what was learned");
});

test("a node without history refuses old ranges at once, not after shrinking", async () => {
  let calls = 0;
  const request: RpcRequest = async () => {
    calls++;
    throw new Error("Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode");
  };
  await assert.rejects(rpcSource({ request }).getLogs({ address: mod, fromBlock: 0, toBlock: 1_000_000 }), /Archive/);
  assert.equal(calls, 1);
});

test("with the explorer's budget spent and an RPC without history, the reader says so", async () => {
  const chain = fakeChain([], 5_000_000);
  const request: RpcRequest = async (method, params) => {
    if (method === "eth_getLogs") throw new Error("Archive requests require a personal token.");
    return chain.request(method, params);
  };
  const spent: LogSource = { name: "Blockscout", getLogs: async () => { throw new SourceUnavailable("Blockscout is rate limited for now."); } };
  const reader = createChainRolesReader({ access: () => ({ explorers: [spent], rpc: rpcSource({ request }), request, floor: 0, unavailable: (limited) => `unavailable (limited: ${limited})` }) });
  await assert.rejects(reader.read({ chainId: 8453, address: mod }), /unavailable \(limited: true\)/);
});

test("the creation block is found by bisecting eth_getCode", async () => {
  assert.equal(await findCreationBlock(fakeChain([], 1_000_000, { createdAt: 777_777 }).request, mod, 0, 1_000_000), 777_777);
  assert.equal(await findCreationBlock(fakeChain([], 1_000, { createdAt: 5_000 }).request, mod, 0, 1_000), null, "no code at the head");
});

test("history falls back to the RPC, the tail always comes from it, and the cache is extended", async () => {
  const latest = 50_000;
  const logs = [
    setup(10_000),
    event("AssignRoles", [member, [key], [true]], 20_000),
    post(owner, { rolesMod: mod, roleKey: key, addAnnotations: [{ uris: ["https://a"], schema: "s" }] }, 30_000),
    event("AllowTarget", [key, target, 0], latest - 5), // inside the tail
  ];
  const chain = fakeChain(logs, latest, { createdAt: 9_000 });
  const store = new Map<string, LogCacheEntry>();
  const cache = { read: async (k: string) => store.get(k), write: async (k: string, entry: LogCacheEntry) => void store.set(k, structuredClone(entry)) };
  const paid: LogSource = { name: "Paid", getLogs: async () => { throw new SourceUnavailable("not on plan"); } };
  const queried: LogQuery[] = [];
  const rpc = rpcSource({ request: chain.request });
  const spy: LogSource = { name: "RPC", getLogs: (query, signal) => { queried.push(query); return rpc.getLogs(query, signal); } };

  const first = await readModifierLogs({ chainId: 1, address: mod, explorers: [paid], rpc: spy, request: chain.request, floor: 0, cache });
  assert.equal(first.length, 4);
  const entry = store.get(`1:${mod}`)!;
  assert.equal(entry.from, 9_000, "starts at the creation block");
  assert.equal(entry.modifier.syncedTo, latest - TAIL_BLOCKS);
  assert.equal(entry.modifier.logs.length, 2, "the tail is never cached");
  assert.equal(entry.posts[owner]!.logs.length, 1);

  const later = event("AssignRoles", [owner, [key], [true]], latest + 2_000);
  logs.push(later);
  const next = fakeChain(logs, latest + 3_000);
  queried.length = 0;
  const second = await readModifierLogs({ chainId: 1, address: mod, explorers: [], rpc: rpcSource({ request: next.request }), request: next.request, floor: 0, cache });
  assert.equal(second.length, 5);
  assert.ok(!next.calls.some((call) => call.method === "eth_getCode"), "the creation block is cached");
  const ranges = next.calls.filter((call) => call.method === "eth_getLogs").map((call) => Number(BigInt((call.params[0] as { fromBlock: string }).fromBlock)));
  assert.ok(ranges.every((from) => from > latest - TAIL_BLOCKS), "only blocks after the cached history are read");
});

test("each owner's annotation posts are read only for the time they owned the modifier", async () => {
  const latest = 60_000;
  const logs = [
    setup(10_000),
    post(owner, { rolesMod: mod, roleKey: key, addAnnotations: [{ uris: ["https://first"], schema: "s" }] }, 15_000),
    event("OwnershipTransferred", [owner, nextOwner], 20_000),
    post(nextOwner, { rolesMod: mod, roleKey: key, addAnnotations: [{ uris: ["https://second"], schema: "s" }] }, 30_000),
  ];
  const chain = fakeChain(logs, latest, { createdAt: 10_000 });
  const read = await readModifierLogs({ chainId: 1, address: mod, explorers: [], rpc: rpcSource({ request: chain.request }), request: chain.request, floor: 0 });
  assert.equal(read.length, 4);
  const postScans = chain.calls
    .filter((call) => call.method === "eth_getLogs" && (call.params[0] as { address: string }).address === POSTER_ADDRESS.toLowerCase())
    .map((call) => {
      const filter = call.params[0] as { topics: string[]; fromBlock: string; toBlock: string };
      return [`0x${filter.topics[1]!.slice(-40)}`, Number(BigInt(filter.fromBlock)), Number(BigInt(filter.toBlock))];
    });
  assert.deepEqual(postScans, [
    [owner, 10_000, 20_000],
    [nextOwner, 20_000, latest],
  ], "one read per period of ownership");
  assert.deepEqual(replayRolesModifier(mod, read)!.roles[0]!.annotations.map((a) => a.uri), ["https://first", "https://second"]);
});

test("the reader returns the replayed, validated configuration, or null for another contract", async () => {
  const latest = realLogs.at(-1)!.blockNumber + 5_000;
  const chain = fakeChain(realLogs, latest, { createdAt: realLogs[0]!.blockNumber });
  const reader = createChainRolesReader({ access: () => ({ explorers: [], rpc: rpcSource({ request: chain.request }), request: chain.request, floor: 18_692_162 }) });
  const read = await reader.read({ chainId: 1, address: fixture.address });
  assert.equal(read!.roles[0]!.targets[0]!.functions.length, 2);
  const empty = fakeChain([], latest, { createdAt: 0 });
  const none = createChainRolesReader({ access: () => ({ explorers: [], rpc: rpcSource({ request: empty.request }), request: empty.request, floor: 0 }) });
  assert.equal(await none.read({ chainId: 1, address: target }), null);
  await assert.rejects(reader.read({ chainId: 999_999, address: fixture.address }), /Unsupported/);
});
