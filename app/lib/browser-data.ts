/** External reads happen in the browser. No same-origin API routes or server keys. */
import { createRolesReader } from "./roles-reader";
import { parseManualAbi, resolveAbi, type ResolvedAbi } from "./abi-source";
import { localRead, localUpdate } from "./local-db";
import { getApiKey } from "./api-keys";
import { parseAddress, parseChainId } from "./serialize";
export const browserRolesReader=createRolesReader();
function abiId(chainId:number,address:string){return `${parseChainId(chainId)}:${parseAddress(address,"address").toLowerCase()}`;}
export async function readBrowserAbi(chainId:number,address:string,signal?:AbortSignal):Promise<ResolvedAbi|null>{
  const id=abiId(chainId,address);
  try {const cached=await localRead<{abi:ResolvedAbi;expires:number|null}>("abis",id);if(cached && (cached.expires===null || cached.expires>Date.now()))return cached.abi;}catch{/* Public reads still work when local storage is blocked. */}
  const timeout=AbortSignal.timeout(12000);
  const abort=signal?AbortSignal.any([signal,timeout]):timeout;
  const abi=await resolveAbi(chainId,address,abort,getApiKey("etherscan"));
  if(abi){try{const saved=await localUpdate<{abi:ResolvedAbi;expires:number|null}>("abis",id,current=>current?.abi.source==="manual" ? current : {abi,expires:Date.now()+86_400_000});return saved?.abi ?? abi;}catch{/* Cache is optional. */}}
  return abi;
}
export async function saveBrowserAbi(chainId:number,address:string,input:string,name?:string){
  const id=abiId(chainId,address);if(new TextEncoder().encode(input).length>2_000_000)throw new Error("ABI exceeds 2 MB.");
  const parsed=parseManualAbi(input);if(parsed.abi.length>5000 || parsed.functions.length>2000)throw new Error("ABI is too large.");
  const abi:ResolvedAbi={chainId,address:parseAddress(address,"address"),source:"manual",name:name?.slice(0,160)||null,implementation:null,proxyType:null,...parsed};
  await localUpdate("abis",id,()=>({abi,expires:null}));return abi;
}
export async function forgetBrowserAbi(chainId:number,address:string){await localUpdate("abis",abiId(chainId,address),()=>undefined);}
