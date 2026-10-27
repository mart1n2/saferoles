import assert from "node:assert/strict";
import test from "node:test";
import { fromRolesMod, toSdkState } from "../app/lib/policy-codec";
import { buildPlan } from "../app/lib/policy-plan";

const rolesMod="0x0f253F99a3AC0122cc9ef0d61e35F27d6d017269";
const usdc="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const member="0x66e5C961140dbC5859A39853f2cCfA4fA4F7A07a";
const mod={
  address:rolesMod,owner:rolesMod,avatar:rolesMod,target:rolesMod,multiSendAddresses:[],allowances:[],
  roles:[{key:"0x626f740000000000000000000000000000000000000000000000000000000000" as const,members:[member],annotations:[],lastUpdate:1,
    targets:[{address:usdc,clearance:2,executionOptions:0,functions:[{selector:"0x095ea7b3" as const,wildcarded:false,executionOptions:0,
      condition:{paramType:5,operator:5,children:[{paramType:1,operator:16,compValue:"0x00000000000000000000000087870bca3f3fd6335c3f4ce8392d69350b4fa4e2",children:[]}]}}]}]}],
};
test("an untouched indexed policy plans no calls even with checksummed addresses",()=>{
  const current={roles:mod.roles,allowances:mod.allowances};
  const {state,issues}=toSdkState(fromRolesMod(mod as never,1));
  const plan=buildPlan({rolesMod,current:current as never,desired:state,issues});
  assert.equal(plan.issues.length,0);
  assert.deepEqual(plan.transactions,[]);
  assert.deepEqual(plan.changes,[]);
});
test("adding transfer on a target that already has approve only plans the new function (no conditions = allowFunction)",()=>{
  const current={roles:mod.roles,allowances:mod.allowances};
  const draft=fromRolesMod(mod as never,1);
  const role=draft.roles[0]!;
  const approve=role.permissions[0]!;
  role.permissions.push({...approve,id:"new-transfer",selector:undefined,rawCondition:undefined,signature:"transfer(address to, uint256 value)",conditions:[]});
  const {state,issues}=toSdkState(draft);
  const plan=buildPlan({rolesMod,current:current as never,desired:state,issues});
  assert.equal(plan.issues.length,0);
  assert.deepEqual(plan.changes.map(c=>c.call.call),["allowFunction"]);
});
