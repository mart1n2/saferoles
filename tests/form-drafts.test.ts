import { indexedDB, IDBKeyRange } from "fake-indexeddb";
Object.assign(globalThis,{indexedDB,IDBKeyRange});
import assert from "node:assert/strict";
import test from "node:test";
import {
  clearSavedForm,formKeys,isRecoveredPolicyChange,isRecoveredPolicyStale,MAX_FORM_BYTES,
  parsePolicyWorkingCopy,parseScopeFormState,parseSetupFormState,readSavedForm,writeSavedForm,
} from "../app/lib/form-drafts";
import { localRead, localUpdate } from "../app/lib/local-db";
import type { DraftPolicy, DraftRole } from "../app/lib/policy";

const rolesMod=`0x${"1".repeat(40)}`,safeAddress=`0x${"2".repeat(40)}`;
const role:DraftRole={id:"r1",key:"ops",name:"Ops",description:"",members:[],permissions:[]};
const policy:DraftPolicy={chainId:1,rolesMod,roles:[role],allowances:[]};
const setupForm={role,memberAddress:"0x12",keyEdited:false,saltNonce:"42",step:"role" as const};
const hash="a".repeat(64);

test("keys are scoped by chain and lowercased address",()=>{
  assert.equal(formKeys.policy(1,rolesMod.toUpperCase().replace("0X","0x")),formKeys.policy(1,rolesMod));
  assert.notEqual(formKeys.policy(1,rolesMod),formKeys.policy(10,rolesMod));
  assert.notEqual(formKeys.setup(1,safeAddress),formKeys.policy(1,safeAddress));
});
test("saved forms roundtrip and are cleared",async()=>{
  const key=formKeys.policy(1,rolesMod);
  assert.equal(await readSavedForm(key,v=>parsePolicyWorkingCopy(v,{chainId:1,rolesMod})),null);
  const savedAt=await writeSavedForm(key,{policy,baseHash:hash});
  const loaded=await readSavedForm(key,v=>parsePolicyWorkingCopy(v,{chainId:1,rolesMod}));
  assert.equal(loaded?.savedAt,savedAt);assert.equal(loaded?.data.baseHash,hash);assert.equal(loaded?.data.policy.roles[0]?.name,"Ops");
  await clearSavedForm(key);
  assert.equal(await localRead("forms",key),undefined);
});
test("corrupt, foreign or mismatched records are discarded on read",async()=>{
  const key=formKeys.scopeLookup();
  for(const raw of ["not json",JSON.stringify({format:"other",version:1,key,savedAt:1,data:{}}),JSON.stringify({format:"saferoles-form",version:2,key,savedAt:1,data:{}}),JSON.stringify({format:"saferoles-form",version:1,key:"other",savedAt:1,data:{}})]){
    await localUpdate<string>("forms",key,()=>raw);
    assert.equal(await readSavedForm(key,parseScopeFormState),null);
    assert.equal(await localRead("forms",key),undefined);
  }
  await writeSavedForm(key,{chainId:1,address:"0x1",extra:true});
  assert.equal(await readSavedForm(key,parseScopeFormState),null);
  assert.equal(await localRead("forms",key),undefined);
});
test("a policy saved for another modifier is rejected",()=>{
  assert.throws(()=>parsePolicyWorkingCopy({policy:{...policy,chainId:10},baseHash:null},{chainId:1,rolesMod}));
  assert.throws(()=>parsePolicyWorkingCopy({policy,baseHash:"nothex"},{chainId:1,rolesMod}),/SHA-256/);
  assert.throws(()=>parsePolicyWorkingCopy({policy,baseHash:null,x:1},{chainId:1,rolesMod}),/not a supported/);
});
test("setup form validation",()=>{
  const scope={chainId:1,safeAddress};
  assert.equal(parseSetupFormState(setupForm,scope).saltNonce,"42");
  assert.throws(()=>parseSetupFormState({...setupForm,step:"done"},scope),/step/);
  assert.throws(()=>parseSetupFormState({...setupForm,keyEdited:"yes"},scope),/keyEdited/);
  assert.throws(()=>parseSetupFormState({...setupForm,saltNonce:"4x"},scope),/digits/);
  assert.throws(()=>parseSetupFormState({...setupForm,memberAddress:"a".repeat(5000)},scope),/at most/);
  assert.throws(()=>parseSetupFormState({...setupForm,apiKey:"secret"},scope),/not a supported/);
});
test("scope form validation",()=>{
  assert.deepEqual(parseScopeFormState({chainId:10,address:"0xabc"}),{chainId:10,address:"0xabc"});
  assert.throws(()=>parseScopeFormState({chainId:0,address:""}),/chainId/);
  assert.throws(()=>parseScopeFormState({chainId:1.5,address:""}),/chainId/);
  assert.throws(()=>parseScopeFormState({chainId:1,address:"x".repeat(129)}),/address/);
});
test("oversized forms are refused",async()=>{
  await assert.rejects(writeSavedForm("big",{blob:"x".repeat(MAX_FORM_BYTES)}),/2 MB/);
  assert.equal(await localRead("forms","big"),undefined);
});
test("restore decisions compare against the indexed baseline",()=>{
  assert.equal(isRecoveredPolicyChange({policy,baseHash:null},policy),false);
  assert.equal(isRecoveredPolicyChange({policy:{...policy,roles:[]},baseHash:null},policy),true);
  assert.equal(isRecoveredPolicyStale({baseHash:hash},hash),false);
  assert.equal(isRecoveredPolicyStale({baseHash:hash},"b".repeat(64)),true);
  assert.equal(isRecoveredPolicyStale({baseHash:null},hash),false);
  assert.equal(isRecoveredPolicyStale({baseHash:hash},null),false);
});
