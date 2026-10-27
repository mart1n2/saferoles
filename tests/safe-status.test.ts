import assert from "node:assert/strict";
import test from "node:test";
import { parseHostTransaction, parseServiceTransaction } from "../app/lib/safe-transaction-status";
import { readSafeTransactionStatus } from "../app/lib/safe-status-reader";
const scope={chainId:1,safeAddress:`0x${"1".repeat(40)}`,safeTxHash:`0x${"2".repeat(64)}`};
const owner=`0x${"3".repeat(40)}`;
const execution=`0x${"4".repeat(64)}`;
const tx={safe:scope.safeAddress,safeTxHash:scope.safeTxHash,isExecuted:false,isSuccessful:null,confirmationsRequired:2,confirmations:[{owner}],transactionHash:null};
test("Safe service keeps signature threshold and execution success distinct",()=>{
  assert.equal(parseServiceTransaction(tx,scope).state,"awaiting-confirmations");
  assert.equal(parseServiceTransaction({...tx,confirmationsRequired:1},scope).state,"awaiting-execution");
  assert.equal(parseServiceTransaction({...tx,isExecuted:true,isSuccessful:true,transactionHash:execution},scope).state,"success");
  assert.equal(parseServiceTransaction({...tx,isExecuted:true,isSuccessful:false},scope).state,"failed");
  assert.equal(parseServiceTransaction({...tx,isExecuted:true},scope).state,"unknown");
  assert.equal(parseServiceTransaction({...tx,confirmations:[{owner},{owner}]},scope).confirmations,1);
});
test("Safe status rejects mismatched identity and incomplete success evidence",()=>{
  assert.throws(()=>parseServiceTransaction({...tx,safe:owner},scope),/does not match/);
  assert.throws(()=>parseServiceTransaction({...tx,safeTxHash:execution},scope),/does not match/);
  assert.throws(()=>parseServiceTransaction({...tx,confirmationsRequired:null},scope),/threshold/);
  assert.throws(()=>parseServiceTransaction({...tx,transactionHash:"wallet-bundle"},scope),/hash/);
  assert.throws(()=>parseServiceTransaction({...tx,isExecuted:undefined},scope),/missing/);
});
test("Safe host status preserves cancellation and unknown future statuses",()=>{
  const host={safeAddress:scope.safeAddress,txStatus:"CANCELLED",detailedExecutionInfo:{safeTxHash:scope.safeTxHash,confirmationsRequired:2,confirmations:[{}]}};
  assert.equal(parseHostTransaction(host,scope).state,"cancelled");
  assert.equal(parseHostTransaction({...host,txStatus:"FUTURE_STATUS"},scope).state,"unknown");
  assert.throws(()=>parseHostTransaction({...host,safeAddress:owner},scope),/does not match/);
  assert.throws(()=>parseHostTransaction({...host,detailedExecutionInfo:{}},scope),/does not match/);
});
test("Safe status reader uses a fixed authenticated read endpoint without caching or redirects",async()=>{
  const fetcher:typeof fetch=async(input,init)=>{
    assert.equal(String(input),`https://api.safe.global/tx-service/eth/api/v2/multisig-transactions/${scope.safeTxHash}/`);
    assert.equal(new Headers(init?.headers).get("Authorization"),"Bearer test-key");
    assert.equal(init?.cache,"no-store");assert.equal(init?.redirect,"error");
    return Response.json(tx);
  };
  assert.equal((await readSafeTransactionStatus(scope,"test-key",fetcher)).source,"safe-service");
});
test("missing/indexing/transport errors never become failed or successful statuses",async()=>{
  for(const code of [404,401,429,500]) {
    const fetcher:typeof fetch=async()=>new Response(null,{status:code});
    await assert.rejects(readSafeTransactionStatus(scope,"key",fetcher),code===404 ? /does not mean it failed/ : /unavailable/);
  }
  await assert.rejects(readSafeTransactionStatus({...scope,chainId:12345678},"key"),/Unsupported/);
});
