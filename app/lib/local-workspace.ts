import { localList, localRead, localUpdate } from "./local-db";
import { parseDraftCreatePayload, parseDraftUpdatePayload, parseProposalPayload, parseDraftPolicy, parse, stringify, type DraftCreatePayload, type DraftUpdatePayload } from "./serialize";
import type { DraftPolicy } from "./policy";
import type { SubmissionResult } from "./submission";
export type LocalDraft = {
  id:string;name:string;chainId:number;rolesMod:string;safeAddress:string;policy:DraftPolicy;
  baseStateHash:string|null;createdBy:string;version:number;createdAt:number;updatedAt:number;
};
export type LocalSubmission = {id:string;chainId:number;rolesMod:string;safeAddress:string;submission:SubmissionResult;callCount:number;risk:string;proposedBy:string;createdAt:number};
function decodeDraft(raw:string):LocalDraft {
  const row=parse<LocalDraft>(raw);
  if(!row || typeof row.id!=="string" || !Number.isSafeInteger(row.version) || row.version<1 || !Number.isSafeInteger(row.updatedAt))throw new Error("Local draft is corrupt.");
  const data=parseDraftCreatePayload(rowInput(row));
  return {...row,...data};
}
function rowInput(row:LocalDraft) {return {name:row.name,chainId:row.chainId,rolesMod:row.rolesMod,safeAddress:row.safeAddress,policy:row.policy,baseStateHash:row.baseStateHash};}
export async function listLocalDrafts(chainId:number,rolesMod:string) {
  return (await localList<string>("drafts")).map(decodeDraft).filter(row=>row.chainId===chainId && row.rolesMod.toLowerCase()===rolesMod.toLowerCase()).sort((a,b)=>b.updatedAt-a.updatedAt);
}
export async function readLocalDraft(id:string,chainId:number,rolesMod:string) {
  const raw=await localRead<string>("drafts",id);
  if(!raw)throw new Error("This local draft no longer exists.");
  const row=decodeDraft(raw);
  if(row.chainId!==chainId || row.rolesMod.toLowerCase()!==rolesMod.toLowerCase())throw new Error("The draft belongs to a different modifier.");
  return row;
}
export async function saveLocalDraft(input:DraftCreatePayload|DraftUpdatePayload,id?:string):Promise<LocalDraft> {
  const data=id ? parseDraftUpdatePayload(input) : parseDraftCreatePayload(input);
  const draftId=id ?? crypto.randomUUID();
  const raw=await localUpdate<string>("drafts",draftId,current=>{
    const old=current ? decodeDraft(current):null;
    if(id && (!old || !("version" in data) || old.version!==data.version))throw new Error("This draft changed in another tab. Reopen it before saving.");
    if(old && (old.chainId!==data.chainId || old.rolesMod.toLowerCase()!==data.rolesMod.toLowerCase()))throw new Error("Draft scope cannot change.");
    const now=Date.now();
    return stringify({...old,...data,id:draftId,safeAddress:old?.safeAddress ?? (data as DraftCreatePayload).safeAddress,version:(old?.version??0)+1,createdBy:"This browser",createdAt:old?.createdAt??now,updatedAt:now});
  });
  return decodeDraft(raw!);
}
export async function removeLocalDraft(id:string,chainId:number,rolesMod:string,version:number) {
  await localUpdate<string>("drafts",id,current=>{if(!current)return undefined;const row=decodeDraft(current);if(row.chainId!==chainId || row.rolesMod.toLowerCase()!==rolesMod.toLowerCase() || row.version!==version)throw new Error("Draft changed. Refresh before deleting.");return undefined;});
}
export async function recordLocalSubmission(input:unknown) {
  const data=parseProposalPayload(input);
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(stringify(data.submission)));
  const id=`${data.chainId}:${data.safeAddress.toLowerCase()}:${Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("")}`;
  const row:LocalSubmission={id,chainId:data.chainId,rolesMod:data.rolesMod,safeAddress:data.safeAddress,submission:data.submission,callCount:data.calls.length,risk:data.risk,proposedBy:"This browser",createdAt:Date.now()};
  await localUpdate<string>("submissions",id,current=>current ?? stringify(row));
}
export async function listLocalSubmissions(chainId:number,rolesMod:string):Promise<LocalSubmission[]> {
  return (await localList<string>("submissions")).map(raw=>parse<LocalSubmission>(raw)).filter(row=>row.chainId===chainId && row.rolesMod.toLowerCase()===rolesMod.toLowerCase()).sort((a,b)=>b.createdAt-a.createdAt);
}
/** Export contains only the selected draft. API credentials are in a separate store. */
export function exportLocalDraft(row:LocalDraft) {return stringify({format:"saferoles-draft",version:1,draft:rowInput(row)});}
export async function importLocalDraft(text:string):Promise<LocalDraft> {
  if(new TextEncoder().encode(text).length>2_000_000)throw new Error("Draft file exceeds 2 MB.");
  const file=parse<{format:string;version:number;draft:DraftCreatePayload}>(text);
  if(file.format!=="saferoles-draft" || file.version!==1)throw new Error("Unsupported draft file.");
  parseDraftPolicy(file.draft.policy,{chainId:file.draft.chainId,rolesMod:file.draft.rolesMod});
  return saveLocalDraft(parseDraftCreatePayload(file.draft));
}
