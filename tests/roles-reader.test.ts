import assert from "node:assert/strict";
import test from "node:test";
import { encodeKey, ParameterType, Operator } from "zodiac-roles-sdk";
import { createRolesReader, parseIndexedModifier } from "../app/lib/roles-reader";

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

test("reader binds chain/address, preserves fresh-read options and distinguishes absent from unavailable", async () => {
  const reader = createRolesReader({ endpoint: "https://indexer.example.test/graphql", fetcher: async (url, options) => {
    assert.equal(url,"https://indexer.example.test/graphql");
    assert.equal(options!.method,"POST");
    assert.equal(options!.cache,"no-store");
    assert.equal(new Headers(options!.headers).get('cache-control'),'no-cache');
    const query=JSON.parse(options!.body as string);
    assert.equal(query.variables.id,`eth:${modifier}`);
    return Response.json({ data: { rolesModifier: snapshot() } });
  } });
  assert.equal((await reader.read({chainId:1,address:modifier},{cache:'no-store',headers:{'cache-control':'no-cache'}}))!.address,modifier);
  const absent=createRolesReader({fetcher:async()=>Response.json({data:{rolesModifier:null}})});
  assert.equal(await absent.read({chainId:1,address:modifier}),null);
  for(const response of [new Response('down',{status:503}),Response.json({errors:[{message:'bad'}]}),Response.json({data:{}})]) {
    await assert.rejects(createRolesReader({fetcher:async()=>response}).read({chainId:1,address:modifier}));
  }
});

test("discovery rejects a response for another Safe", async () => {
  const reader=createRolesReader({fetcher:async()=>Response.json({data:{rolesModifiers:[{address:modifier,chainId:1,owner:safe,avatar:target,target:safe}]}})});
  await assert.rejects(reader.discover(safe),/different Safe/);
});
