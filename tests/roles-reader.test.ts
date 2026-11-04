import assert from "node:assert/strict";
import test from "node:test";
import { encodeKey, ParameterType, Operator } from "zodiac-roles-sdk";
import { createIndexerReader, createPreferredRolesReader, parseIndexedModifier, type RolesReader } from "../app/lib/roles-reader";

const safe = "0x1111111111111111111111111111111111111111";
const modifier = "0x2222222222222222222222222222222222222222";
const target = "0x3333333333333333333333333333333333333333";
function snapshot() {
  return { address: modifier, owner: safe, avatar: safe, target: safe,
    roles: [{ key: encodeKey("ops"), lastUpdate: 1, members: [{ member: { address: safe } }], annotations: [],
      targets: [{ address: target, clearance: "Function", executionOptions: "None", functions: [{ selector: "0xa9059cbb", executionOptions: "None", wildcarded: false, condition: { json: JSON.stringify({paramType:ParameterType.Calldata,operator:Operator.Matches,children:[{paramType:ParameterType.Static,operator:Operator.EqualToAvatar,compValue:"0x"}]}) } }] }] }],
    allowances: [{key:encodeKey("budget"),balance:"9007199254740993",maxRefill:"9007199254740999",refill:"10",period:"86400",timestamp:"123"}],
    unwrapAdapters: [{ targetAddress: target, selector:"0x8d80ff0a", adapterAddress:"0xb4cd4bb764c089f20da18700ce8bc5e49f369efd" }],
  };
}

test("indexer adapter preserves exact amounts, members, conditions and unwrappers", () => {
  const mod = parseIndexedModifier(snapshot(), modifier);
  assert.equal(mod.allowances[0].balance,9007199254740993n);
  assert.deepEqual(mod.roles[0].members,[safe]);
  assert.equal(mod.roles[0].targets[0].functions[0].condition!.children![0].compValue,undefined);
  assert.equal(mod.multiSendAddresses[0].toLowerCase(),target);
});

test("incomplete or malformed indexed policy is never an empty baseline", () => {
  const mutations: ((data: ReturnType<typeof snapshot>) => void)[] = [
    d=>{Reflect.deleteProperty(d,'roles');}, d=>{Reflect.deleteProperty(d.roles[0],'annotations');},
    d=>{d.roles[0].targets[0].clearance='Surprise';}, d=>{d.allowances[0].balance='1.5';},
    d=>{d.allowances[0].period=String(1n<<64n);},
    d=>{Reflect.deleteProperty(d.roles[0].targets[0].functions[0],'condition');},
    d=>{d.roles[0].targets[0].functions[0].condition.json='{}';},
  ];
  for(const mutate of mutations){const data=snapshot();mutate(data);assert.throws(()=>parseIndexedModifier(data,modifier));}
  assert.throws(()=>parseIndexedModifier(snapshot(),target),/different modifier/);
});

test("the indexer reader binds chain and address, and tells absent from unavailable", async () => {
  const reader = createIndexerReader({ endpoint: "https://indexer.example.test/graphql", fetcher: async (url, options) => {
    assert.equal(url, "https://indexer.example.test/graphql");
    assert.equal(options!.method, "POST");
    assert.equal(options!.cache, "no-store");
    const query = JSON.parse(options!.body as string);
    assert.equal(query.variables.id, `eth:${modifier}`);
    return Response.json({ data: { rolesModifier: snapshot() } });
  } });
  assert.equal((await reader.read({ chainId: 1, address: modifier }))!.address, modifier);
  const absent = createIndexerReader({ fetcher: async () => Response.json({ data: { rolesModifier: null } }) });
  assert.equal(await absent.read({ chainId: 1, address: modifier }), null);
  for (const response of [new Response("down", { status: 503 }), Response.json({ errors: [{ message: "bad" }] }), Response.json({ data: {} })]) {
    await assert.rejects(createIndexerReader({ fetcher: async () => response }).read({ chainId: 1, address: modifier }));
  }
});

test("indexer discovery rejects a response for another Safe", async () => {
  const reader = createIndexerReader({ fetcher: async () => Response.json({ data: { rolesModifiers: [{ address: modifier, chainId: 1, owner: safe, avatar: target, target: safe }] } }) });
  await assert.rejects(reader.discover(safe), /different Safe/);
});

test("the probe answers false instead of throwing when the indexer is down", async () => {
  assert.equal(await createIndexerReader({ fetcher: async () => new Response("<html>404</html>", { status: 404 }) }).probe(), false);
  assert.equal(await createIndexerReader({ fetcher: async () => { throw new TypeError("Failed to fetch"); } }).probe(), false);
  assert.equal(await createIndexerReader({ fetcher: async () => Response.json({ data: { __typename: "Query" } }) }).probe(), true);
});

function stubs({ up, indexed }: { up: boolean; indexed: (address: string) => "found" | "absent" | "error" }) {
  const calls = { probe: 0, indexer: 0, chain: 0 };
  const mod = parseIndexedModifier(snapshot(), modifier);
  const indexer = {
    probe: async () => { calls.probe++; return up; },
    discover: async () => [],
    read: async ({ address }: { address: string }) => {
      calls.indexer++;
      const answer = indexed(address);
      if (answer === "error") throw new Error("indexer down");
      return answer === "found" ? mod : null;
    },
  };
  const chain: RolesReader = { read: async () => { calls.chain++; return mod; } };
  return { reader: createPreferredRolesReader({ indexer, chain }), calls };
}

test("the official indexer is used when it answers, probed once per session", async () => {
  const { reader, calls } = stubs({ up: true, indexed: () => "found" });
  await reader.read({ chainId: 1, address: modifier });
  await reader.read({ chainId: 1, address: modifier });
  await reader.read({ chainId: 1, address: target });
  assert.deepEqual(calls, { probe: 1, indexer: 3, chain: 0 });
});

test("a down indexer is not retried: the chain serves the session", async () => {
  const { reader, calls } = stubs({ up: false, indexed: () => "found" });
  await reader.read({ chainId: 1, address: modifier });
  await reader.read({ chainId: 1, address: target });
  assert.deepEqual(calls, { probe: 1, indexer: 0, chain: 2 });
  assert.deepEqual(await reader.discover(safe), []);
});

test("each modifier stays with the source that first served it", async () => {
  let state: "absent" | "found" = "absent";
  const { reader, calls } = stubs({ up: true, indexed: () => state });
  await reader.read({ chainId: 1, address: modifier }); // not indexed yet: from the chain
  state = "found";
  await reader.read({ chainId: 1, address: modifier }); // stays on the chain
  assert.deepEqual(calls, { probe: 1, indexer: 1, chain: 2 });
});

test("an indexer that fails after the probe hands the session to the chain", async () => {
  const { reader, calls } = stubs({ up: true, indexed: () => "error" });
  await reader.read({ chainId: 1, address: modifier });
  await reader.read({ chainId: 1, address: target });
  assert.deepEqual(calls, { probe: 1, indexer: 1, chain: 2 });
});
