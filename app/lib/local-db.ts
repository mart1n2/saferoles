/** This database is local to the browser origin, including Safe iframe partitioning. */
export const LOCAL_DATABASE = "saferoles-workspace-v1";
/**
 * Bump this whenever a store is added: an existing browser database is upgraded
 * in place, and missing stores are created on the upgrade.
 */
export const LOCAL_DATABASE_VERSION = 3;
export const localStores = ["drafts", "submissions", "abis", "secrets", "forms", "labels"] as const;
export type LocalStore = typeof localStores[number];
let opening: Promise<IDBDatabase> | null = null;
export function openLocalDatabase(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise<IDBDatabase>((resolve,reject)=>{
    if (typeof indexedDB === "undefined") {reject(new Error("Local storage is unavailable. Export your work before closing this page."));return;}
    const request=indexedDB.open(LOCAL_DATABASE,LOCAL_DATABASE_VERSION);
    request.onupgradeneeded=()=>{for(const name of localStores) if(!request.result.objectStoreNames.contains(name))request.result.createObjectStore(name);};
    request.onerror=()=>reject(new Error("Could not open local storage. Check browser storage permissions."));
    request.onblocked=()=>reject(new Error("Close other SafeRoles tabs to update local storage."));
    request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();opening=null;};resolve(db);};
  }).catch(error=>{opening=null;throw error;});
  return opening;
}
export async function localRead<T>(store:LocalStore,key:string):Promise<T|undefined> {
  const db=await openLocalDatabase();
  return new Promise((resolve,reject)=>{const tx=db.transaction(store,"readonly");const req=tx.objectStore(store).get(key);tx.oncomplete=()=>resolve(req.result as T|undefined);tx.onerror=()=>reject(new Error("Could not read local storage."));tx.onabort=tx.onerror;});
}
export async function localList<T>(store:LocalStore):Promise<T[]> {
  const db=await openLocalDatabase();
  return new Promise((resolve,reject)=>{const tx=db.transaction(store,"readonly");const req=tx.objectStore(store).getAll();tx.oncomplete=()=>resolve(req.result as T[]);tx.onerror=()=>reject(new Error("Could not list local records."));tx.onabort=tx.onerror;});
}
/** Read/version-check/write happen in one transaction, also across tabs. */
export async function localUpdate<T>(store:LocalStore,key:string,update:(current:T|undefined)=>T|undefined):Promise<T|undefined> {
  const db=await openLocalDatabase();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(store,"readwrite");const object=tx.objectStore(store);const req=object.get(key);let result:T|undefined;let problem:unknown;
    req.onsuccess=()=>{try{result=update(req.result as T|undefined);if(result===undefined)object.delete(key);else object.put(result,key);}catch(error){problem=error;tx.abort();}};
    tx.oncomplete=()=>{if(typeof window!=="undefined")window.dispatchEvent(new Event("saferoles-storage"));resolve(result);};
    tx.onerror=tx.onabort=()=>reject(problem ?? new Error("Could not save locally. Check storage permissions and available space."));
  });
}
