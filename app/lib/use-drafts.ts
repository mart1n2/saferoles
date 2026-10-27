import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DraftPolicy } from "./policy";
import { listLocalDrafts,readLocalDraft,saveLocalDraft,removeLocalDraft,type LocalDraft } from "./local-workspace";
export type DraftSummary = Omit<LocalDraft,"policy">;
export function useDrafts(chainId:number|null,rolesMod:string|null) {
  const [drafts,setDrafts]=useState<DraftSummary[]>([]);
  const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);
  const identity=chainId!==null && rolesMod ? `${chainId}:${rolesMod.toLowerCase()}`:null;
  const active=useRef(identity);
  useLayoutEffect(()=>{active.current=identity;return()=>{active.current=null;};},[identity]);
  const generation=useRef(0);
  const refresh=useCallback(async()=>{
    if(active.current!==identity)return;
    const token=++generation.current;
    if(chainId===null || !rolesMod){setDrafts([]);return;}
    setBusy(true);setError(null);
    try {const rows=await listLocalDrafts(chainId,rolesMod);if(active.current===identity && token===generation.current)setDrafts(rows);}
    catch(caught){if(active.current===identity && token===generation.current)setError(caught instanceof Error?caught.message:"Could not read local drafts.");}
    finally{if(active.current===identity && token===generation.current)setBusy(false);}
  },[chainId,rolesMod,identity]);
  useEffect(()=>{const timer=setTimeout(()=>void refresh(),0);return()=>{clearTimeout(timer);};},[refresh]);
  const save=useCallback(async(input:{name:string;policy:DraftPolicy;safeAddress:string;baseStateHash:string|null;draftId?:string|null;draftVersion?:number|null})=>{
    if(chainId===null || !rolesMod)throw new Error("No modifier is open.");
    if(input.policy.chainId!==chainId || input.policy.rolesMod.toLowerCase()!==rolesMod.toLowerCase())throw new Error("Draft scope does not match the open modifier.");
    setBusy(true);
    try {
      const row=input.draftId
        ? await saveLocalDraft({chainId,rolesMod,policy:input.policy,name:input.name,baseStateHash:input.baseStateHash,version:input.draftVersion??0},input.draftId)
        : await saveLocalDraft({chainId,rolesMod,policy:input.policy,name:input.name,baseStateHash:input.baseStateHash,safeAddress:input.safeAddress});
      if(active.current!==identity)throw new Error("The open modifier changed during save.");
      await refresh();return {id:row.id,version:row.version};
    }finally{if(active.current===identity)setBusy(false);}
  },[chainId,rolesMod,identity,refresh]);
  const open=useCallback(async(summary:DraftSummary)=>{
    if(chainId===null || !rolesMod)throw new Error("No modifier is open.");
    const row=await readLocalDraft(summary.id,chainId,rolesMod);
    if(active.current!==identity)throw new Error("The open modifier changed during load.");
    return {policy:row.policy,baseStateHash:row.baseStateHash,version:row.version};
  },[chainId,rolesMod,identity]);
  const remove=useCallback(async(summary:DraftSummary)=>{try{if(chainId===null||!rolesMod)return;await removeLocalDraft(summary.id,chainId,rolesMod,summary.version);await refresh();return true;}catch(caught){setError(caught instanceof Error?caught.message:"Could not delete local draft.");return false;}},[chainId,rolesMod,refresh]);
  return {drafts,busy,error,available:true,refresh,save,open,remove};
}
