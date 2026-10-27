import { ModalPortal } from "./modal-portal";
import { useEffect, useState, useSyncExternalStore } from "react";
import { apiServices, apiKeysRevision, serverApiKeysRevision, subscribeApiKeys, getApiKey, setSessionApiKey, rememberApiKey, unlockApiKey, forgetApiKey, lockApiKeys, savedApiKey, type ApiService } from "../lib/api-keys";
import { useDismissOnEscape } from "../lib/use-dismiss-on-escape";
const names:Record<ApiService,string>={safe:"Safe Infrastructure",etherscan:"Etherscan"};
const purposes:Record<ApiService,string>={safe:"Optional. Reads Safe transaction status and queue details with your own rate limit.",etherscan:"Optional. Looks up contract ABIs so functions show names instead of hex selectors."};
export function ApiKeySettings(){
  const [open,setOpen]=useState(false);
  return <><button className="button ghost" onClick={()=>setOpen(true)}>API keys</button>{open && <SettingsDialog onClose={()=>setOpen(false)}/>}</>;
}
function SettingsDialog({onClose}:{onClose:()=>void}){
  const [busy,setBusy]=useState(false);
  const [epoch,setEpoch]=useState(0);
  useDismissOnEscape(()=>{if(!busy)onClose();});
  return <ModalPortal><div className="modal-backdrop"><section className="modal connection-modal" role="dialog" aria-modal="true" aria-labelledby="api-keys-title">
    <div className="modal-heading"><div><span className="eyebrow">This browser only</span><h2 id="api-keys-title">API keys</h2></div><button className="icon-button" aria-label="Close API keys" disabled={busy} onClick={onClose}>×</button></div>
    <p className="key-intro">Everything works without keys. Add one only if you hit rate limits. Keys go straight to the service, stay in memory unless you save them encrypted, and are never included in exports.</p>
    {apiServices.map(service=><ApiKeyForm key={`${service}:${epoch}`} service={service} onBusy={setBusy} locked={busy}/>)}
    <button className="button secondary" disabled={busy} onClick={()=>{lockApiKeys();setEpoch(value=>value+1);}}>Lock all keys</button>
    <p className="inline-empty">Encryption protects saved data. Unlocked keys remain accessible to page scripts. Never enter a wallet private key or seed phrase. Forgetting your passphrase requires replacing the saved API key. Keys are excluded from draft exports.</p>
  </section></div></ModalPortal>;
}
function ApiKeyForm({service,onBusy,locked}:{service:ApiService;onBusy:(busy:boolean)=>void;locked:boolean}){
  const revision=useSyncExternalStore(subscribeApiKeys,apiKeysRevision,serverApiKeysRevision);
  const [key,setKey]=useState("");const [password,setPassword]=useState("");const [confirmation,setConfirmation]=useState("");
  const [remember,setRemember]=useState(false);const [saved,setSaved]=useState(false);const [busy,setBusy]=useState(false);const [message,setMessage]=useState<string|null>(null);
  useEffect(()=>{let cancelled=false;void savedApiKey(service).then(value=>{if(!cancelled)setSaved(!!value);}).catch(()=>{if(!cancelled)setMessage("Encrypted storage unavailable. You can still use a key in memory.");});return()=>{cancelled=true;};},[service,revision]);
  async function run(action:()=>Promise<void>|void,success:string){setBusy(true);onBusy(true);setMessage(null);try{await action();setKey("");setPassword("");setConfirmation("");setMessage(success);}catch(error){setMessage(error instanceof Error?error.message:"Could not update the API key.");}finally{setBusy(false);onBusy(false);}}
  const status=getApiKey(service)?"Unlocked for this page session":saved?"Saved encrypted · locked":"No active key";
  return <fieldset className="api-key-form" disabled={busy||locked}>
    <legend>{names[service]}</legend><small>{status} · {purposes[service]}</small>
    <label className="modal-field"><span>{names[service]} API key</span><input type="password" autoComplete="off" value={key} onChange={event=>setKey(event.target.value)} spellCheck={false}/></label>
    <label><input type="checkbox" checked={remember} onChange={event=>setRemember(event.target.checked)}/> Save encrypted on this browser</label>
    {(remember || saved) && <label className="modal-field"><span>{names[service]} passphrase</span><input type="password" autoComplete="off" value={password} onChange={event=>setPassword(event.target.value)}/></label>}
    {remember && <label className="modal-field"><span>Confirm passphrase</span><input type="password" autoComplete="off" value={confirmation} onChange={event=>setConfirmation(event.target.value)}/><small>At least 12 characters. The passphrase is never saved.</small></label>}
    <div className="boot-actions"><button className="button primary" disabled={!key.trim() || (remember && (password.length<12 || password!==confirmation))} onClick={()=>void run(()=>remember?rememberApiKey(service,key,password):setSessionApiKey(service,key),remember?"Encrypted key saved and unlocked.":"Key active in memory only. Any previously saved encrypted key is unchanged.")}>{remember?"Encrypt and save":"Use in memory"}</button>
    {!key.trim() && !saved && <small className="key-hint">Paste a key to continue.</small>}
    {remember && key.trim() && (password.length<12 || password!==confirmation) && <small className="key-hint">{password.length<12?"Passphrase needs at least 12 characters.":"Passphrases do not match."}</small>}
    {saved && <><button className="button secondary" disabled={!password} onClick={()=>void run(()=>unlockApiKey(service,password),"Key unlocked for this page session.")}>Unlock saved key</button><button className="button ghost" onClick={()=>void run(()=>forgetApiKey(service),"Saved key deleted and session key cleared.")}>Delete saved key</button></>}</div>
    {message && <p role="status" className="inline-empty">{message}</p>}
  </fieldset>;
}
