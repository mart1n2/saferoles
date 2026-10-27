import assert from "node:assert/strict";
import test from "node:test";
import { shortWord, summarizeCondition } from "../app/lib/condition-summary";
import { isBlankPermission, toSdkState } from "../app/lib/policy-codec";
import type { DraftPermission, DraftPolicy } from "../app/lib/policy";

const blank:DraftPermission={id:"p",name:"",targetAddress:"",mode:"function",signature:"",send:false,delegatecall:false,conditions:[]};
const rolesMod=`0x${"1".repeat(40)}`;
test("deployed conditions read as plain constraints",()=>{
  const lines=summarizeCondition({paramType:5,operator:5,children:[
    {paramType:1,operator:16,compValue:"0x00000000000000000000000087870bca3f3fd6335c3f4ce8392d69350b4fa4e2",children:[]},
    {paramType:1,operator:0,children:[]},
    {paramType:1,operator:18,compValue:"0x00000000000000000000000000000000000000000000000000000000000f4240",children:[]},
  ]} as never);
  assert.deepEqual(lines,["arg 0 = 0x8787…a4e2","arg 2 < 1000000"]);
  assert.equal(shortWord(undefined),"…");
});
test("a never-started permission is neither an error nor a request",()=>{
  assert.equal(isBlankPermission(blank),true);
  assert.equal(isBlankPermission({...blank,targetAddress:"0x1"}),false);
  const draft:DraftPolicy={chainId:1,rolesMod,roles:[{id:"r",key:"bot",name:"bot",description:"",members:[],permissions:[blank]}],allowances:[]};
  assert.deepEqual(toSdkState(draft).issues,[]);
  const half:DraftPolicy={...draft,roles:[{...draft.roles[0]!,permissions:[{...blank,signature:"transfer(address,uint256)"}]}]};
  assert.ok(toSdkState(half).issues.length>0);
});
