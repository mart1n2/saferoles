import assert from "node:assert/strict";
import test from "node:test";
import { Interface } from "ethers";
import {
  LEGACY_MULTISEND_UNWRAPPER, MORPHO_MULTICALL_SELECTOR, MULTISEND_SELECTOR, MULTISEND_UNWRAPPER, UNWRAP_TARGETS,
  encodeUnwrapCall, readUnwrapperStates, unwrapCallFor, unwrapperKey, type UnwrapperReader,
} from "../app/lib/unwrappers";
import { parseDraftPolicy } from "../app/lib/serialize";
import { withUnwrappers, type Plan } from "../app/lib/policy-plan";

const rolesMod=`0x${"1".repeat(40)}`;
const empty:Plan={calls:[],transactions:[],changes:[],issues:[],risk:"Low"};

test("selectors match the batch functions they stand for",()=>{
  const i=new Interface(["function multiSend(bytes)","function multicall((address,bytes,uint256,bool,bytes32)[])"]);
  assert.equal(i.getFunction("multiSend")!.selector,MULTISEND_SELECTOR);
  assert.equal(i.getFunction("multicall")!.selector,MORPHO_MULTICALL_SELECTOR);
});
test("mapping key is bytes20(to) followed by the selector",()=>{
  const key=unwrapperKey("0x9641d764fc13c8B624c04430C7356C1C7C8102e2",MULTISEND_SELECTOR);
  assert.equal(key,"0x9641d764fc13c8b624c04430c7356c1c7c8102e28d80ff0a000000000000000000000000".slice(0,66));
  assert.equal(key.length,66);
});
test("status is read from the chain for each target",async()=>{
  const reader=(adapter:string,code=true):UnwrapperReader=>({unwrapperOf:async()=>adapter,hasCode:async()=>code});
  const zero="0x0000000000000000000000000000000000000000";
  assert.equal((await readUnwrapperStates(1,reader(zero)))["multisend-141"]!.status,"missing");
  assert.equal((await readUnwrapperStates(1,reader(MULTISEND_UNWRAPPER)))["multisend-141"]!.status,"enabled");
  assert.equal((await readUnwrapperStates(1,reader(LEGACY_MULTISEND_UNWRAPPER)))["multisend-141"]!.status,"legacy");
  assert.equal((await readUnwrapperStates(1,reader(zero,false)))["multisend-141"]!.status,"unavailable");
  assert.equal((await readUnwrapperStates(137,reader(zero)))["morpho-bundler3"]!.status,"missing");
  assert.equal((await readUnwrapperStates(56,reader(zero)))["morpho-bundler3"]!.status,"unavailable");
});
test("enabling plans an owner call to the modifier with the official adapter only",()=>{
  const plan=withUnwrappers(empty,rolesMod,1,["morpho-bundler3","multisend-141","unknown"]);
  assert.equal(plan.transactions.length,2);
  assert.ok(plan.transactions.every(tx=>tx.to===rolesMod&&tx.value==="0"&&tx.operation===0));
  const i=new Interface(["function setTransactionUnwrapper(address to, bytes4 selector, address adapter)"]);
  const decoded=i.decodeFunctionData("setTransactionUnwrapper",plan.transactions[0]!.data);
  assert.equal(decoded[2],UNWRAP_TARGETS.find(t=>t.id==="morpho-bundler3")!.adapter);
  assert.equal(plan.changes[0]!.action,"Batching");
  assert.equal(plan.risk,"Medium");
  assert.equal(unwrapCallFor("morpho-bundler3",56),null);
  assert.equal(unwrapCallFor("morpho-bundler3",137)!.to,"0x2d9C3A9E67c966C711208cc78b34fB9E9f8db589");
  assert.equal(withUnwrappers(empty,rolesMod,1,undefined),empty);
  assert.equal(encodeUnwrapCall(unwrapCallFor("multisend-141",1)!).slice(0,10),i.getFunction("setTransactionUnwrapper")!.selector);
});
test("drafts only carry known batch targets",()=>{
  const base={chainId:1,rolesMod,roles:[],allowances:[]};
  assert.deepEqual(parseDraftPolicy({...base,unwrappers:["multisend-141","multisend-141"]},{chainId:1,rolesMod}).unwrappers,["multisend-141"]);
  assert.equal(parseDraftPolicy(base,{chainId:1,rolesMod}).unwrappers,undefined);
  assert.throws(()=>parseDraftPolicy({...base,unwrappers:["0xevil"]},{chainId:1,rolesMod}),/supported batch target/);
});
