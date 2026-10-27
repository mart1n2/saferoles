import assert from "node:assert/strict";
import test from "node:test";
import { encodeFunctionResult, parseAbi, decodeFunctionData } from "viem";
import { createWalletRpc, type WalletProvider } from "../app/lib/wallet-rpc";
import { PartialSubmissionError } from "../app/lib/submission";
import { walletChains } from "../app/lib/wallet-config";
import { supportedChainIds } from "../app/lib/chains";

const safe="0x1111111111111111111111111111111111111111";
const owner="0x2222222222222222222222222222222222222222";
const tx={to:owner,value:"0",data:"0x"};
const safeAbi=parseAbi(["function VERSION() view returns (string)","function getOwners() view returns (address[])","function getThreshold() view returns (uint256)","function nonce() view returns (uint256)","function isModuleEnabled(address) view returns (bool)"]);
function fixture(options:{atomic?:boolean;code?:string;threshold?:bigint}={}) {
  const requests:{method:string;params?:unknown[]|object}[]=[];
  const state={account:safe,chainId:1,sent:0};
  const provider:WalletProvider={async request(args){
    requests.push(args);
    if(args.method==="eth_accounts")return [state.account];
    if(args.method==="eth_chainId")return `0x${state.chainId.toString(16)}`;
    if(args.method==="eth_getCode")return options.code ?? "0x6000";
    if(args.method==="wallet_getCapabilities")return options.atomic ? {"0x1":{atomic:{status:"supported"}}} : {};
    if(args.method==="wallet_sendCalls")return {id:"chosen-wallet-bundle"};
    if(args.method==="eth_sendTransaction"){state.sent++;return `0x${String(state.sent).padStart(64,'0')}`;}
    if(args.method==="eth_call"){
      const [call]=(args.params as [{data:`0x${string}`}]);
      const {functionName}=decodeFunctionData({abi:safeAbi,data:call.data});
      switch(functionName){
        case "VERSION":return encodeFunctionResult({abi:safeAbi,functionName,result:"1.4.1"});
        case "getOwners":return encodeFunctionResult({abi:safeAbi,functionName,result:[owner]});
        case "getThreshold":return encodeFunctionResult({abi:safeAbi,functionName,result:options.threshold ?? 1n});
        case "nonce":return encodeFunctionResult({abi:safeAbi,functionName,result:0n});
        case "isModuleEnabled":return encodeFunctionResult({abi:safeAbi,functionName,result:true});
      }
    }
    throw new Error(`Unexpected RPC: ${args.method}`);
  }};
  return {provider,state,requests,rpc:createWalletRpc(provider,{account:safe,chainId:1})};
}

test("wallet network definitions cover exactly the Roles-supported chains",()=>{
  assert.deepEqual(walletChains.map(c=>c.id).sort((a,b)=>a-b),[...supportedChainIds].sort((a,b)=>a-b));
});

test("viem reads only through the selected provider and verifies Safe wiring",async()=>{
  const selected=fixture(),other=fixture();
  const inspection=await selected.rpc.inspectSafe(safe,owner);
  assert.equal(inspection.status,"valid");assert.equal(inspection.moduleEnabled,true);
  assert.equal(other.requests.length,0);
  assert.equal((await fixture({code:"0x"}).rpc.inspectSafe(safe)).status,"invalid");
  assert.notEqual((await fixture({threshold:2n}).rpc.inspectSafe(safe)).status,"valid");
});

test("wallet atomic submission retains bundle identity and atomicRequired",async()=>{
  const f=fixture({atomic:true});
  assert.deepEqual(await f.rpc.send([tx],true),{kind:"bundleId",bundleId:"chosen-wallet-bundle"});
  const sent=f.requests.find(r=>r.method==="wallet_sendCalls")!;
  const payload=(sent.params as {from:string;atomicRequired:boolean;calls:unknown[]}[])[0];
  assert.equal(payload.from.toLowerCase(),safe);assert.equal(payload.atomicRequired,true);assert.equal(payload.calls.length,1);
  const sequential=fixture();
  await assert.rejects(sequential.rpc.send([tx],true),/Atomic batch support/);
  assert.equal(sequential.state.sent,0);
});

test("account, network or connector changes invalidate pending submission",async()=>{
  for(const change of ['account','chainId'] as const){
    const f=fixture({atomic:true});
    if(change==='account')f.state.account=owner;else f.state.chainId=10;
    await assert.rejects(f.rpc.send([tx]),/changed/);
    assert.ok(!f.requests.some(r=>r.method==='wallet_sendCalls'||r.method==='eth_sendTransaction'));
  }
  const f=fixture({atomic:true});
  await assert.rejects(createWalletRpc(f.provider,{account:safe,chainId:1},()=>{throw new Error('Connector changed');}).send([tx]),/Connector changed/);
});

test("switching accounts during a sequential batch preserves submitted hashes",async()=>{
  const f=fixture();
  const provider:WalletProvider={async request(args){
    const result=await f.provider.request(args);
    if(args.method==='eth_sendTransaction')f.state.account=owner;
    return result;
  }};
  await assert.rejects(createWalletRpc(provider,{account:safe,chainId:1}).send([tx,tx]),error=>{
    assert.ok(error instanceof PartialSubmissionError);
    assert.equal(error.submission.txHashes.length,1);
    return true;
  });
  assert.equal(f.state.sent,1);
});
