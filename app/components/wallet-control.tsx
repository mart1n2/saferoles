import { useState } from "react";
import type { WalletState } from "../lib/use-wallet";
import { shortHex } from "../lib/abi";
import { useDismissOnEscape } from "../lib/use-dismiss-on-escape";

export function WalletControl({ wallet }: { wallet: WalletState }) {
  const [open,setOpen]=useState(false);
  const [pending,setPending]=useState<string|null>(null);
  useDismissOnEscape(()=>{if(!pending)setOpen(false);});
  async function choose(id:string) {
    setPending(id);
    try {await wallet.connect(id);setOpen(false);}
    catch { /* The hook exposes the connector error in the dialog. */ }
    finally {setPending(null);}
  }
  return <>
    {wallet.account && <span className="wallet-chip" title={wallet.account}><span className="wallet-status-dot" />{shortHex(wallet.account)}<small>{wallet.walletName}</small></span>}
    <button className="button secondary" disabled={wallet.status==="connecting"} onClick={()=>setOpen(true)}>
      {wallet.status==="connecting" ? "Connecting…" : wallet.account ? "Change wallet" : "Connect wallet"}
    </button>
    {wallet.account && <button className="button ghost" onClick={()=>void wallet.disconnect().catch(()=>{})}>Disconnect</button>}
    {open && <div className="modal-backdrop" role="presentation" onClick={()=>{if(!pending)setOpen(false);}}>
      <section className="modal connection-modal" role="dialog" aria-modal="true" aria-labelledby="wallet-title" onClick={event=>event.stopPropagation()}>
        <div className="modal-heading"><div><span className="eyebrow">Wallet connection</span><h2 id="wallet-title">Choose a wallet</h2><p>Select the browser wallet to use for this connection.</p></div>
          <button className="icon-button" aria-label="Close wallet selector" disabled={!!pending} onClick={()=>setOpen(false)}>×</button>
        </div>
        <div className="mod-list">{wallet.wallets.map(option=><button className="mod-option" key={option.id} disabled={!!pending} onClick={()=>void choose(option.id)}>
          <span><b>{option.name}</b><small>{pending===option.id ? "Waiting for wallet…" : "Connect this wallet"}</small></span><span aria-hidden="true">→</span>
        </button>)}</div>
        {!wallet.wallets.length && <p className="inline-empty">No browser wallet announced itself. Install or unlock a wallet, then reload.</p>}
        {wallet.error && <p className="error-text" role="alert">{wallet.error}</p>}
        <p className="inline-empty">Connecting a wallet does not grant permissions. To make changes, approve through Safe or connect a wallet with your Safe selected.</p>
      </section>
    </div>}
  </>;
}
