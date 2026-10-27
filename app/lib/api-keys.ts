/** API keys are memory-only until the user explicitly chooses encrypted storage. */
import { localRead, localUpdate } from "./local-db";
export type ApiService = "safe" | "etherscan";
export const apiServices:ApiService[]=["safe","etherscan"];
export type EncryptedApiKey={version:1;service:ApiService;iterations:600000;salt:string;iv:string;ciphertext:string};
const iterations=600000;
const encoder=new TextEncoder();
const memory=new Map<ApiService,string>();
const listeners=new Set<()=>void>();
let revision=0;
export const subscribeApiKeys=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
export const apiKeysRevision=()=>revision;
export const serverApiKeysRevision=()=>0;
function changed(){revision++;for(const listener of listeners)listener();}
export function getApiKey(service:ApiService){return memory.get(service);}
export function setSessionApiKey(service:ApiService,key:string){validateKey(key);memory.set(service,key.trim());changed();}
export function lockApiKeys(){memory.clear();changed();}
function validateKey(key:string){if(!key.trim() || key.length>8192 || /[\r\n]/.test(key))throw new Error("Enter a valid API key (at most 8192 characters).");}
function base64(bytes:Uint8Array){return btoa(String.fromCharCode(...bytes));}
function bytes(text:string,size?:number){if(typeof text!=="string" || text.length>12000)throw new Error("Invalid encrypted credential.");const value=Uint8Array.from(atob(text),c=>c.charCodeAt(0));if(size && value.length!==size)throw new Error("Invalid encrypted credential.");return value;}
async function derive(password:string,salt:Uint8Array<ArrayBuffer>){
  const material=await crypto.subtle.importKey("raw",encoder.encode(password),"PBKDF2",false,["deriveKey"]);
  return crypto.subtle.deriveKey({name:"PBKDF2",hash:"SHA-256",salt,iterations},material,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
}
export async function encryptApiKey(service:ApiService,key:string,password:string):Promise<EncryptedApiKey>{
  validateKey(key);if(password.length<12 || password.length>1024)throw new Error("Use a passphrase of 12–1024 characters.");
  const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
  const derived=await derive(password,salt);
  const encrypted=await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:encoder.encode(`saferoles-api-key:1:${service}`)},derived,encoder.encode(key.trim()));
  return {version:1,service,iterations,salt:base64(salt),iv:base64(iv),ciphertext:base64(new Uint8Array(encrypted))};
}
export async function decryptApiKey(service:ApiService,envelope:EncryptedApiKey,password:string):Promise<string>{
  if(!envelope || envelope.version!==1 || envelope.service!==service || envelope.iterations!==iterations || password.length>1024)throw new Error("Unsupported encrypted credential.");
  try {
    const derived=await derive(password,bytes(envelope.salt,16));
    const result=await crypto.subtle.decrypt({name:"AES-GCM",iv:bytes(envelope.iv,12),additionalData:encoder.encode(`saferoles-api-key:1:${service}`)},derived,bytes(envelope.ciphertext));
    const key=new TextDecoder("utf-8",{fatal:true}).decode(result);validateKey(key);return key;
  }catch{throw new Error("Could not unlock: incorrect passphrase or damaged encrypted data.");}
}
export async function savedApiKey(service:ApiService){return localRead<EncryptedApiKey>("secrets",service);}
export async function rememberApiKey(service:ApiService,key:string,password:string){const envelope=await encryptApiKey(service,key,password);await localUpdate("secrets",service,()=>envelope);setSessionApiKey(service,key);}
export async function unlockApiKey(service:ApiService,password:string){const envelope=await savedApiKey(service);if(!envelope)throw new Error("No encrypted API key is saved for this service.");const key=await decryptApiKey(service,envelope,password);setSessionApiKey(service,key);}
export async function forgetApiKey(service:ApiService){await localUpdate("secrets",service,()=>undefined);memory.delete(service);changed();}
