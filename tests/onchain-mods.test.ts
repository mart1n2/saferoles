import assert from "node:assert/strict";
import test from "node:test";
import { discoverOnChain, mergeMods, type ModuleReader } from "../app/lib/onchain-mods";
const safe=`0x${"2".repeat(40)}`,roles=`0x${"3".repeat(40)}`,other=`0x${"4".repeat(40)}`,foreign=`0x${"5".repeat(40)}`;
const reader:ModuleReader={
  enabled:async()=>true,
  modules:async()=>[roles,other,foreign],
  probe:async m=>m===roles?{owner:safe,avatar:safe,target:safe}:m===foreign?{owner:safe,avatar:other,target:other}:null,
};
test("only modules whose avatar is the Safe are listed",async()=>{
  const mods=await discoverOnChain(safe,1,reader);
  assert.deepEqual(mods.map(m=>m.address.toLowerCase()),[roles]);
  assert.equal(mods[0]?.chainId,1);
});
test("merging keeps indexed rows and adds chain-only modules once",()=>{
  const a={address:roles,chainId:1},b={address:other,chainId:1};
  assert.deepEqual(mergeMods([a],[{...a,address:roles.toUpperCase().replace("0X","0x")},b]),[a,b]);
});
import { readUnindexedModifier } from "../app/lib/onchain-mods";
test("an unindexed modifier needs an on-chain answer and an enabling Safe",async()=>{
  const ok:ModuleReader={...reader,enabled:async()=>true};
  const mod=await readUnindexedModifier(roles,1,ok);
  assert.equal(mod?.avatar.toLowerCase(),safe);assert.deepEqual(mod?.roles,[]);
  assert.equal(await readUnindexedModifier(roles,1,{...ok,enabled:async()=>false}),null);
  assert.equal(await readUnindexedModifier(other,1,ok),null);
});
